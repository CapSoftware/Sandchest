/**
 * What each scan workflow step does. Steps pass ids only: no code or
 * finding text ever goes into workflow storage. Every write is idempotent,
 * because a step that dies is retried from the start.
 */
import { withUtm } from "@/lib/analytics";
import { RECON_WAIT } from "@/lib/scan-progress";
import { DEEP_SCAN_TIERS, deepScanCredits, prReviewCredits } from "@sandchest/billing";
import { criticalFindingEmail, deepScanEmail } from "@sandchest/email";
import {
  claimNotification,
  claimScanSlot,
  EventWriter,
  knownFindings,
  markDeepScanned,
  markFixed,
  markStale,
  newerPrReview,
  nextUsageAttempt,
  noteScanEvent,
  notificationRecipients,
  openFindings,
  earlierPrFindings,
  insertUsage,
  pendingRecon,
  prComment,
  recordMetrics,
  repoHistory,
  savePrComment,
  saveThreatModel,
  scanById,
  setComputeCost,
  setRepoLoc,
  threatModel as storedThreatModel,
  updateScan,
  upsertFindings,
  type FindingInput,
  type FindingRow,
} from "@sandchest/db";
import { createIndexerClient } from "@sandchest/engine/indexer";
import { LlmQuotaError } from "@sandchest/engine/llm";
import {
  adoptKnownFingerprints,
  changedLines,
  checkFixes,
  isDependencyManifest,
  relevantChanges,
  runRecon,
  runScan,
  ScanRefusedError,
  storableLeads,
  ThreatModelSchema,
  UnpricedCallError,
  type ChangedFile,
  type Finding,
  type ScanEvent,
  type ThreatModel,
} from "@sandchest/engine/scan";
import { checkResult, GitHubError, notReviewed, parsePatch, prSummary, prSummaryUnfinished, reviewComment, shown, type Installation, type PullFile, type ReviewComment } from "@sandchest/github";
import type { IndexerBinary, IndexerHandle, Workspace } from "@sandchest/workspace";
import { LocalWorkspace } from "@sandchest/workspace/local";
import { SandboxWorkspace } from "@sandchest/workspace/sandbox";
import { BoatWorkspace } from "@sandchest/workspace/boat";
import { billingEnabled, heldCredits, reserveScan, settleScan, syncBilling, type Gate } from "./billing";
import { config, scanEngine, scanPricing, scanWorkspace, type Config } from "./config";
import { describeError } from "./log";
import { captureFromScan } from "./cves";
import { sliceAllowedNow } from "./slice-limit";
import { noticeScanPaused } from "./notices";
import { classifier, classifierPrice, db, githubApp, llmClient, mailer, osvClient, pricing } from "./services";
import { captureException } from "./sentry";
import { readSandboxUsage, UsageLedger } from "./usage-ledger";

/** Concurrent scans per org (SPEC §4), in each lane: recon, PR reviews, and everything else (see `claimScanSlot`). */
export const ORG_CONCURRENCY = 2;
/** PR reviews are short and someone is waiting on each one, so their lane is wider. */
export const PR_REVIEW_CONCURRENCY = 4;
/** The step's wall-clock budget for setup plus the engine: under Vercel's 800 s function limit. */
const SCAN_BUDGET_MS = 12 * 60_000;
/** Setup (sandbox, clone, indexer) spends no model calls, so it is retried in the step, with backoff, before a scan fails. */
const SETUP_RETRY_DELAYS_MS = [10_000, 30_000];
/** No new setup attempt starts after this long, so the engine keeps most of the budget. */
const SETUP_DEADLINE_MS = 4 * 60_000;
const CLONE_TIMEOUT_MS = 4 * 60_000;
const CHECK_NAME = "Sandchest";

/** A scan's job is done; retries and duplicate starts must not redo it. */
export class ScanFinished extends Error {}

/**
 * `engine` is set only for a scan the slice engine runs; anything else (old results included) runs classic.
 * `pricing` is set only for a slice scan billed from its usage (or in shadow): only then does a bill step run.
 */
export type BeginResult = { state: "running" | "queued" | "done"; engine?: "slice"; pricing?: "usage" | "shadow" };

/**
 * Lets the scan run (its credits held, or the org's plan checked), claims a
 * concurrency slot and, for PRs, posts the in-progress Check straight away.
 */
export async function beginScan(scanId: string): Promise<BeginResult> {
  const scan = await requireScan(scanId);
  if (["completed", "failed", "cancelled", "refused", "publishing"].includes(scan.status)) return { state: "done" };
  // A push that lands while this review is still queued makes it moot: the newer head is reviewed instead.
  if (scan.status === "queued" && scan.kind === "pr_review" && scan.prNumber && (await newerPrReview(db(), { id: scan.id, repoId: scan.repoId, prNumber: scan.prNumber, headSha: scan.headSha, createdAt: scan.createdAt }))) {
    await settleScan(scan, "release").catch((error: unknown) => console.error(`Releasing superseded scan ${scan.id} failed: ${describeError(error)}`));
    await updateScan(db(), scan.id, { status: "cancelled", error: "A newer push to this pull request is reviewed instead.", finishedAt: new Date() });
    return { state: "done" };
  }
  // How the scan was priced when its credits were reserved, if they were: by an earlier run of this step, by Dig or the dashboard, or just below.
  let pricing = scan.pricing;
  // A queued scan with no stored pricing is priced now, so the slice engine's daily limit applies to it.
  const sliceAllowed = scan.status === "queued" && !pricing ? await sliceAllowedNow(scan.kind, scan.repo.org.githubLogin) : true;
  if (scan.status === "queued" && scan.billing === null && billingEnabled()) {
    const priced = scanPricing(scan, scan.repo.org.githubLogin, config(), sliceAllowed);
    const gate = await reserveScan(scan.id, { id: scan.orgId, githubLogin: scan.repo.org.githubLogin }, heldCredits(priced, await scanCredits(scan)), true, { evenWhenEmpty: scan.kind === "fix_check", pricing: priced });
    if (!gate.ok) {
      // Billing is being upgraded: nothing is held now. The workflow asks again every 10 s, and this goes ahead once it's done.
      if (gate.reason === "frozen") {
        await noteScanEvent(db(), scan.id, "queue", FROZEN_WAIT);
        return { state: "queued" };
      }
      await refuse(scan, { reason: gate.reason, credits: gate.credits });
      return { state: "done" };
    }
    pricing = priced;
  }
  // A deep scan of a repo still being mapped waits for the map and builds on it, rather than mapping it again
  // beside the recon (the first deep scan starts the moment recon does).
  if (scan.status === "queued" && scan.kind === "deep" && (await pendingRecon(db(), scan.repoId))) {
    await noteScanEvent(db(), scan.id, RECON_WAIT, `Waiting for recon to map ${scan.repo.fullName} first, usually under a minute. The deep scan starts from that map as soon as it’s done.`);
    return { state: "queued" };
  }
  const limit = scan.kind === "pr_review" ? PR_REVIEW_CONCURRENCY : ORG_CONCURRENCY;
  if (!(await claimScanSlot(db(), scan.id, scan.orgId, limit))) {
    // Said once (a repeat of the last line is skipped), so the feed explains the wait.
    const what = scan.kind === "recon" ? "repositories are being mapped" : scan.kind === "pr_review" ? "reviews are already running" : "scans are already running";
    const message =
      scan.kind === "fix_check"
        ? `Waiting for a free slot: a repository's fix checks run one at a time, at most one a minute, with up to ${ORG_CONCURRENCY} scans at once for ${scan.repo.org.githubLogin}. Later pushes are checked in this one.`
        : `Waiting for a free slot: ${limit} ${what} for ${scan.repo.org.githubLogin}. This starts as soon as one finishes.`;
    await noteScanEvent(db(), scan.id, "queue", message);
    return { state: "queued" };
  }
  if (scan.kind === "pr_review" && !scan.checkRunId && scan.repo.org.installationId) {
    const checkRunId = await githubApp()
      .installation(scan.repo.org.installationId)
      .createCheckRun(scan.repo.fullName, {
        name: CHECK_NAME,
        headSha: scan.headSha,
        externalId: scan.id,
        detailsUrl: detailsUrl(scan.id, "github", "check"),
        output: { title: "Scanning…", summary: "Reviewing this change for exploitable vulnerabilities." },
      });
    await updateScan(db(), scan.id, { checkRunId });
  }
  // A scan holding credits keeps the engine it was priced for, whatever the settings say now.
  if ((pricing?.engine ?? scanEngine(scan.kind, scan.repo.org.githubLogin, config(), sliceAllowed)) === "slice") {
    return { state: "running", engine: "slice", ...((pricing?.mode === "usage" || pricing?.mode === "shadow") && { pricing: pricing.mode }) };
  }
  return { state: "running" };
}

/** The feed's line while billing is frozen: said once, however many times the scan asks again. */
export const FROZEN_WAIT = "Waiting: billing is being upgraded. This starts by itself in a few minutes.";

/** What a scan costs, before it runs. A PR review costs what the engine will report for the same files. */
async function scanCredits(scan: LoadedScan): Promise<number> {
  // Not sized yet: hold the most a deep scan can cost; the charge is what it measures.
  if (scan.kind === "deep") return (scan.repo.loc === null ? undefined : deepScanCredits(scan.repo.loc)) ?? DEEP_SCAN_TIERS.at(-1)!.credits;
  if (scan.kind !== "pr_review" || !scan.prNumber || !scan.repo.org.installationId) return 0;
  const files = await githubApp().installation(scan.repo.org.installationId).pullFiles(scan.repo.fullName, scan.prNumber);
  const relevant = relevantChanges(files.map(toChangedFile));
  return relevant.length ? prReviewCredits(changedLines(relevant)) : 0;
}

/** A scan billing would not let run: recorded as refused, and a PR gets a neutral Check that never blocks merging. */
async function refuse(scan: LoadedScan, gate: { reason: Exclude<Extract<Gate, { ok: false }>["reason"], "frozen">; credits: number }): Promise<void> {
  const message = gate.reason === "no_plan" ? "Not run: this account has no plan." : `Not run: out of credits (needs ${gate.credits}).`;
  // The Check first: once the scan is marked refused, a retried step would never post it.
  let checkRunId = scan.checkRunId;
  if (scan.kind === "pr_review" && scan.repo.org.installationId) {
    const installation = githubApp().installation(scan.repo.org.installationId);
    const { conclusion, output } = notReviewed(gate.reason, withUtm(`${appUrl()}/dashboard/settings/billing`, "github", "check"), gate.credits);
    checkRunId ??= await installation.createCheckRun(scan.repo.fullName, { name: CHECK_NAME, headSha: scan.headSha, externalId: scan.id, output });
    await installation.completeCheckRun(scan.repo.fullName, checkRunId, conclusion, output);
    // A PR with an earlier summary must not keep showing it as the latest result. One without gets the Check alone.
    // Best effort: a retry from here would post a second Check, since the first isn't recorded until below.
    if (scan.prNumber) {
      await postSummary(scan, installation, prSummaryUnfinished({ headSha: scan.headSha, detailsUrl: withUtm(`${appUrl()}/dashboard/settings/billing`, "github", "comment"), reason: gate.reason }), { create: false }).catch((error: unknown) =>
        console.error(`Summary for refused scan ${scan.id} failed: ${describeError(error)}`),
      );
    }
  }
  await updateScan(db(), scan.id, { status: "refused", error: message, finishedAt: new Date(), checkRunId });
}

/** Clones, indexes and runs the engine; persists findings and the feed as they happen. */
export async function executeScan(scanId: string, run: { /** How many times the workflow has run this step, when it says. */ attempt?: number } = {}): Promise<{ findings: number }> {
  const scan = await requireScan(scanId);
  if (scan.status !== "running") return { findings: 0 };
  const installationId = scan.repo.org.installationId;
  if (!installationId || !scan.repo.enabled) throw new ScanFinished("Repository is no longer installed");

  const installation = githubApp().installation(installationId);
  // A fix check settles what it has to re-check before any sandbox or clone, so a push that touches no cited file costs one API call.
  const { findings: affected, changes } = scan.kind === "fix_check" ? await affectedFindings(scan, installation) : { findings: [], changes: [] };
  if (scan.kind === "fix_check" && affected.length === 0) return { findings: 0 };
  const events = new EventWriter(db(), scan.id);
  // Every model call and the sandbox, with what each cost. Records only; a failed write is tried again, and rows never written are reported.
  // A step the workflow runs again records under the next attempt, so a bill can count the latest one alone.
  // One past anything already recorded, and never under the workflow's own count: a run whose rows were not written yet still gets a number of its own.
  const attempt = Math.max(await nextUsageAttempt(db(), scan.id, "execute"), run.attempt ?? 0);
  const ledger = new UsageLedger({ scanId: scan.id, write: (rows) => insertUsage(db(), scan.id, rows), step: "execute", attempt });
  // A stage's name travels with it ("stage:hunt"), so the page can light its step on the track.
  const onEvent = (event: ScanEvent) =>
    events.write(event.type === "stage" ? `stage:${event.stage}` : event.type, event.type === "finding" ? `Found: ${event.finding.title}` : event.message);
  events.write("stage:setup", "Starting a fresh sandbox and fetching the code…");
  const settings = config();
  const started = Date.now();
  const url = `${(settings.SANDCHEST_GIT_HOST ?? "https://github.com").replace(/\/$/, "")}/${scan.repo.fullName}.git`;
  // "HEAD" is the remote's default branch as it is now, so a renamed default branch still clones.
  // The configured workspace, or Boat for an account SANDCHEST_ENGINE_ORGS puts on the slice engine.
  const where = scanWorkspace(scan.repo.org.githubLogin, settings);
  const preparing = prepareWorkspace({
    open: () =>
      where === "sandbox"
        ? SandboxWorkspace.create({ timeoutMs: SCAN_BUDGET_MS + 5 * 60_000 })
        : where === "boat"
          ? openBoatWorkspace(SCAN_BUDGET_MS + 5 * 60_000)
          : LocalWorkspace.create(),
    clone: async (workspace) => workspace.clone({ url, ref: scan.headSha }, { depth: 1, token: await installation.cloneToken(scan.repo.githubRepoId), timeoutMs: CLONE_TIMEOUT_MS }),
    binary: indexerBinary(where),
    started,
    onRetry: (message) => onEvent({ type: "progress", message }),
  });

  let inventory: ReturnType<typeof captureFromScan> | undefined;
  try {
    // Set up while the diff and the stored threat model load.
    const [{ headSha, handle }, pullFiles, memory] = await Promise.all([
      preparing,
      scan.kind === "pr_review" && scan.prNumber ? installation.pullFiles(scan.repo.fullName, scan.prNumber) : Promise.resolve(undefined),
      storedThreatModel(db(), scan.repo.id),
    ]);
    const indexer = createIndexerClient({ url: handle.url, token: handle.token });
    // Recon, deep scans and fix checks have the default branch checked out: the CVE directory's inventory is read
    // from it while the scan runs. A PR review's checkout is the PR's, not what is installed.
    // The commit was chosen when the scan was made (or now, for "HEAD"), however long it queued.
    inventory = scan.kind === "pr_review" ? undefined : captureFromScan(scan.repo.id, headSha, scan.headSha === "HEAD" ? new Date(started) : scan.createdAt, indexer);
    const model = parseThreatModel(memory?.threatModel);
    // Setup already spent part of the step's time.
    const common = { client: llmClient(), classifier: classifier(), indexer, osv: osvClient(), pricing: pricing(), classifierPrice: classifierPrice(), onEvent, onUsage: ledger.onUsage, limits: { timeBudgetMs: SCAN_BUDGET_MS - (Date.now() - started) } };

    if (scan.kind === "recon") {
      const result = await runRecon(common);
      await saveThreatModel(db(), scan.repo.id, result.threatModel, headSha);
      await recordMetrics(db(), scan.id, { ...usageOf(result.usage), modelCostUsd: result.costUsd, durationMs: result.durationMs, candidates: 0, survivors: 0 });
      await updateScan(db(), scan.id, { stats: { loc: result.loc } });
      await setRepoLoc(db(), scan.repo.id, result.loc);
      return { findings: 0 };
    }

    if (scan.kind === "fix_check") {
      if (!model) return { findings: 0 };
      onEvent({ type: "progress", message: `Re-checking ${affected.length} open ${affected.length === 1 ? "finding" : "findings"} on the new code…` });
      const checkStarted = Date.now();
      // The push's diff goes to the reviewer, so it can tell the fix from a refactor of the same lines.
      const { results, usage, costUsd } = await checkFixes({ ...common, threatModel: model, findings: affected.map(toEngineFinding), changes: changes.map(toChangedFile) });
      const count = (outcome: string) => results.filter((r) => r.outcome === outcome).length;
      await markFixed(db(), results.filter((r) => r.outcome === "fixed").map((r) => r.id), scan.id);
      await markStale(db(), results.filter((r) => r.outcome === "stale").map((r) => r.id), scan.id);
      if (usage) await recordMetrics(db(), scan.id, { ...usageOf(usage), modelCostUsd: costUsd, durationMs: Date.now() - checkStarted, candidates: affected.length, survivors: count("open") });
      onEvent({ type: "stage", stage: "done", message: `Re-checked ${affected.length}: ${count("fixed")} fixed, ${count("open")} still open, ${count("stale")} stale.` });
      await updateScan(db(), scan.id, { stats: { checked: affected.length, fixed: count("fixed") } });
      return { findings: 0 };
    }

    // Deep scans and PR reviews.
    const report = await runScan({
      ...common,
      threatModel: model,
      // What this team already decided about the repo's findings: scans learn from it.
      history: { findings: await repoHistory(db(), scan.repo.id) },
      pullRequest: pullFiles ? { files: pullFiles.map(toChangedFile) } : undefined,
      onEvent,
    });
    if (!model) await saveThreatModel(db(), scan.repo.id, report.threatModel, headSha);
    // A rescan's report of a bug already stored updates it (and keeps the team's verdict) rather than filing it again.
    const recognised = adoptKnownFingerprints(report.findings, await knownFindings(db(), scan.repo.id));
    const { ids, newIds } = await upsertFindings(db(), scan.repo.id, scan, recognised.map(toFindingInput));
    const credits = scan.kind === "pr_review" ? (report.review?.files ? prReviewCredits(report.review.changedLines) : 0) : (deepScanCredits(report.repo.loc) ?? 0);
    await recordMetrics(db(), scan.id, {
      ...usageOf(report.usage.total),
      modelCostUsd: report.usage.costUsd,
      durationMs: report.durationMs,
      candidates: report.stats.candidates,
      survivors: report.stats.survivors,
    });
    await updateScan(db(), scan.id, {
      credits,
      leads: storableLeads(report.leads),
      stats: { findingIds: ids, newFindingIds: newIds, timings: report.timings, review: report.review, warnings: report.warnings, loc: report.repo.loc },
    });
    if (scan.kind === "deep") await markDeepScanned(db(), scan.repo.id, new Date(), report.repo.loc);
    return { findings: ids.length };
  } catch (error) {
    if (error instanceof ScanRefusedError || (scan.headSha === "HEAD" && isEmptyRepoError(error))) {
      const message = error instanceof ScanRefusedError ? error.message : "Nothing to scan yet: the repository has no commits.";
      await updateScan(db(), scan.id, { status: "refused", error: message, finishedAt: new Date() });
      throw new ScanFinished(message);
    }
    if (error instanceof LlmQuotaError) {
      // The fail step that follows gives the credits back. Email is best effort and at most once per scan.
      await noticeScanPaused(scan).catch((failure: unknown) => console.error(`Scan-paused email for scan ${scan.id} failed: ${describeError(failure)}`));
      throw new ScanFinished("The model provider refused for quota reasons; the scan is paused.");
    }
    if (error instanceof UnpricedCallError) throw new ScanFinished("A model call reported no cost, so the scan was stopped.");
    throw error;
  } finally {
    // A setup that failed has already destroyed its own workspace. The inventory is read before the indexer goes.
    const prepared = await preparing.catch(() => undefined);
    await inventory?.read;
    // A Boat sandbox's meter is read before it goes: a deleted sandbox has no usage to read.
    const sandbox = prepared?.workspace instanceof BoatWorkspace ? await readSandboxUsage(prepared.workspace, { scanId: scan.id }) : undefined;
    if (sandbox) ledger.sandbox(sandbox);
    await Promise.allSettled([
      events.flush(),
      prepared?.workspace.destroy(),
      inventory?.done,
      ledger.close().then(async ({ unwritten }) => {
        if (unwritten === 0) return;
        console.error(`Usage ledger for scan ${scan.id}: ${unwritten} rows not written`);
        await captureException(Object.assign(new Error("Usage ledger rows were not written"), { name: "UsageLedgerUnwritten" }), { source: "billing", tags: { scan_id: scan.id, rows: unwritten }, handled: true });
      }),
      sandbox && setComputeCost(db(), scan.id, sandbox.usd).catch((error: unknown) => console.error(`Compute cost for scan ${scan.id} failed: ${describeError(error)}`)),
    ]);
  }
}

/** What a fetch of a branch with no commits says. Retrying never helps. */
export function isEmptyRepoError(error: unknown): boolean {
  return error instanceof Error && /couldn't find remote ref HEAD\b/.test(error.message);
}

/**
 * A fresh workspace with the code checked out and the indexer answering. The
 * indexer downloads while the code is fetched. A failed attempt is thrown away
 * and retried with backoff, until `SETUP_DEADLINE_MS`: setup costs no model
 * calls, and a blip at GitHub or the sandbox host shouldn't fail a review.
 */
export async function prepareWorkspace(input: {
  open: () => Promise<Workspace>;
  clone: (workspace: Workspace) => Promise<void>;
  binary: IndexerBinary;
  started: number;
  onRetry: (message: string) => void;
  wait?: (ms: number) => Promise<void>;
}): Promise<{ workspace: Workspace; headSha: string; handle: IndexerHandle }> {
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    let workspace: Workspace | undefined;
    try {
      workspace = await input.open();
      const ready = workspace;
      await Promise.all([input.clone(ready), ready.installIndexer(input.binary)]);
      const [rev, handle] = await Promise.all([ready.exec(["git", "rev-parse", "HEAD"]), ready.startIndexer(input.binary)]);
      return { workspace: ready, headSha: rev.stdout.trim(), handle };
    } catch (error) {
      await workspace?.destroy().catch(() => {});
      const delay = SETUP_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || isEmptyRepoError(error) || Date.now() + delay - input.started > SETUP_DEADLINE_MS) throw error;
      input.onRetry(`Setup failed (${describeError(error)}); trying again in ${delay / 1000} s.`);
      await wait(delay);
    }
  }
}

/** Completes the PR Check and posts the review. Other scans have nothing to publish. */
export async function publishScan(scanId: string): Promise<void> {
  const scan = await requireScan(scanId);
  // Published already, or failed by the sweep while this ran: its credits are back and its Check closed, so it stays that way.
  if (scan.status !== "running" && scan.status !== "publishing") return;
  const installationId = scan.repo.org.installationId;
  if (scan.kind === "pr_review" && scan.checkRunId && scan.prNumber && installationId) {
    const installation = githubApp().installation(installationId);
    const stats = (scan.stats ?? {}) as PrReviewStats;
    // A finding someone dismissed stays quiet when a later scan finds it again.
    const findings = (await findingsById(stats.findingIds ?? [])).filter((row) => row.status !== "dismissed").map(toEngineFinding);
    const visible = shown(findings) as typeof findings;
    // Every step below can be retried: the review is posted once (recorded in stats), the summary is edited
    // in place, and completing a Check twice is harmless.
    let inline = stats.inline ?? 0;
    // Private repos get findings inline on the diff, unless an earlier review of this PR already reported them:
    // those stay in the summary, so a PR isn't notified about the same bug on every push. Public repos never get details.
    const earlier = await earlierPrFindings(db(), { id: scan.id, repoId: scan.repo.id, prNumber: scan.prNumber, createdAt: scan.createdAt });
    const inlineable = scan.repo.private ? visible.filter((f) => !earlier.has(f.id)) : [];
    // What earlier reviews of this PR found and this one didn't report again stays on the summary while it's open:
    // a rescan of the same code can miss a bug, and the code may be outside the PR, where a later push can't fix it.
    const reported = new Set(findings.map((f) => f.id));
    const carried = (await findingsById([...earlier.keys()].filter((id) => !reported.has(id))))
      .filter((row) => (row.status === "open" || row.status === "verified") && !row.staleAt)
      .map((row) => ({ ...toEngineFinding(row), url: findingUrl(row.id), foundIn: { headSha: earlier.get(row.id)!.headSha, detailsUrl: detailsUrl(earlier.get(row.id)!.scanId, "github", "comment") } }));
    if (inlineable.length > 0 && stats.inline === undefined) {
      inline = await postInlineReview(scan, installation, inlineable);
      await updateScan(db(), scan.id, { stats: { ...stats, inline } });
    }
    await postSummary(scan, installation, prSummary({ findings: findings.map((f) => ({ ...f, url: findingUrl(f.id) })), isPublic: !scan.repo.private, headSha: scan.headSha, detailsUrl: detailsUrl(scan.id, "github", "comment"), credits: scan.credits, inline, earlier: carried, animationUrl: `${appUrl()}/github/review-chest.png?v=${PR_ANIMATION_VERSION}` }), { create: true });
    const threshold = scan.repo.org.settings.checkThreshold;
    const { conclusion, output } = checkResult({ findings, threshold, isPublic: !scan.repo.private, detailsUrl: detailsUrl(scan.id, "github", "check"), credits: scan.credits, inline });
    await installation.completeCheckRun(scan.repo.fullName, scan.checkRunId, conclusion, output);
  }
  await updateScan(db(), scan.id, { status: "completed", finishedAt: new Date() });
  await charge(scan);
  // Email is best effort and at most once: it never fails or repeats a scan.
  await notifyScan(scan).catch(async (error: unknown) => {
    console.error(`Notifications for scan ${scan.id} failed: ${error instanceof Error ? error.name : "error"}`);
    await captureException(error, { source: "notifications", tags: { scan_id: scan.id }, handled: true });
  });
}

/**
 * Emails people with push access about new critical findings, and about
 * every finished deep scan. Reserved before sending, so a retried step never
 * sends twice.
 */
async function notifyScan(scan: NonNullable<Awaited<ReturnType<typeof scanById>>>): Promise<void> {
  if (scan.kind !== "deep" && scan.kind !== "pr_review") return;
  // Uninstalled or removed while the scan ran: nobody is told about code Sandchest may no longer read.
  if (!scan.repo.org.installationId || !scan.repo.enabled) return;
  if (scan.repo.org.settings.emailNotifications === false || !mailer().enabled) return;
  const stats = (scan.stats ?? {}) as { findingIds?: string[]; newFindingIds?: string[] };
  const rows = (await findingsById(stats.findingIds ?? [])).filter((row) => row.status === "open" && row.confidence !== "low");
  const fresh = new Set(stats.newFindingIds ?? []);
  const critical = rows.filter((row) => row.severity === "critical" && fresh.has(row.id));
  if (scan.kind !== "deep" && critical.length === 0) return;
  const recipients = await notificationRecipients(db(), scan.repo.id);
  if (recipients.length === 0 || !(await claimNotification(db(), scan.id))) return;
  const base = config().SANDCHEST_APP_URL.replace(/\/$/, "");
  const medium = scan.kind === "deep" ? "deep_scan" : "critical_finding";
  const summary = (row: FindingRow) => ({ title: row.title, severity: row.severity, url: withUtm(`${base}/dashboard/findings/${row.id}`, "email", medium) });
  const order = ["critical", "high", "medium", "low"];
  const sorted = rows.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const email = scan.kind === "deep" ? deepScanEmail({ repo: scan.repo.fullName, scanUrl: detailsUrl(scan.id, "email", medium), findings: sorted.map(summary) }) : criticalFindingEmail({ repo: scan.repo.fullName, findings: critical.map(summary) });
  await mailer().send({ to: recipients, ...email });
}

/**
 * Charges a completed scan's credits. A failure here never fails the scan: the
 * reservation stays and the sweep settles it later.
 */
async function charge(scan: LoadedScan): Promise<void> {
  if (scan.billing !== "reserved") return;
  try {
    await settleScan(scan, "charge", scan.credits);
    if ((scan.creditsReserved ?? 0) > 0) await syncBilling({ id: scan.orgId, githubLogin: scan.repo.org.githubLogin });
  } catch (error) {
    console.error(`Charging scan ${scan.id} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "charge", scan_id: scan.id }, handled: true });
  }
}

/** Records a failure, gives back the scan's credits and never leaves a PR Check spinning. */
export async function failScan(scanId: string, message: string): Promise<void> {
  const scan = await requireScan(scanId);
  await settleScan(scan, "release").catch(async (error: unknown) => {
    console.error(`Releasing scan ${scan.id} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "release", scan_id: scan.id }, handled: true });
  });
  if (scan.status !== "refused") await updateScan(db(), scan.id, { status: "failed", error: message.slice(0, 2_000), finishedAt: new Date() });
  if (scan.kind === "pr_review" && scan.checkRunId && scan.repo.org.installationId) {
    const installation = githubApp().installation(scan.repo.org.installationId);
    await installation.completeCheckRun(scan.repo.fullName, scan.checkRunId, "neutral", {
      title: scan.status === "refused" ? "Not reviewed" : "Review could not finish",
      summary:
        scan.status === "refused"
          ? message
          : "Sandchest could not finish this review, and nothing was charged. It does not block merging. Comment `/sandchest review` on the pull request, or use Review on the repository's page in Sandchest, to try again.",
    });
    if (scan.prNumber && scan.status !== "refused") {
      // Best effort: the Check above is what must never be left spinning.
      await postSummary(scan, installation, prSummaryUnfinished({ headSha: scan.headSha, detailsUrl: detailsUrl(scan.id, "github", "comment"), reason: "failed" }), { create: false }).catch((error: unknown) =>
        console.error(`Summary for failed scan ${scan.id} failed: ${describeError(error)}`),
      );
    }
  }
}

export type LoadedScan = NonNullable<Awaited<ReturnType<typeof scanById>>>;

export async function requireScan(scanId: string): Promise<LoadedScan> {
  const scan = await scanById(db(), scanId);
  if (!scan) throw new ScanFinished(`Scan ${scanId} not found`);
  return scan;
}

/** Bump after `bun run chest:comment` redraws the animation, so GitHub's image cache fetches the new one. */
const PR_ANIMATION_VERSION = 1;

function appUrl(): string {
  return config().SANDCHEST_APP_URL.replace(/\/$/, "");
}

/** A scan's page, tagged with where the link was put (a Check, a review, an email) so the visit is attributed to it. */
function detailsUrl(scanId: string, source: "email" | "github", medium: string): string {
  return withUtm(`${appUrl()}/dashboard/scans/${scanId}`, source, medium);
}

function findingUrl(findingId: string): string {
  return withUtm(`${appUrl()}/dashboard/findings/${findingId}`, "github", "comment");
}

/** What a PR review's stats hold, as far as publishing reads them. */
type PrReviewStats = { findingIds?: string[]; inline?: number } & Record<string, unknown>;

/**
 * One review with an inline comment per finding that sits on a line of the
 * diff; returns how many were placed. Findings that don't fit stay in the
 * summary. If GitHub won't take the comments (the diff moved on under them),
 * the review is skipped rather than failing the publish: the summary has it all.
 */
async function postInlineReview(scan: LoadedScan, installation: Installation, findings: Array<Finding & { id: string }>): Promise<number> {
  const diffs = new Map((await installation.pullFiles(scan.repo.fullName, scan.prNumber!)).map((f) => [f.filename, parsePatch(f.filename, f.patch)]));
  const comments: ReviewComment[] = [];
  for (const finding of findings) {
    // The sink first, then any other hop that is on a line in the diff.
    const spot = [...finding.attackPath].reverse().find((step) => diffs.get(step.file)?.commentable.has(step.line));
    if (spot) comments.push({ path: spot.file, line: spot.line, side: "RIGHT", body: reviewComment(finding) });
  }
  if (comments.length === 0) return 0;
  const body = `Sandchest flagged ${comments.length === 1 ? "this line" : `${comments.length} lines`} in this change. The summary comment lists everything it found. [Full details →](${detailsUrl(scan.id, "github", "review")})`;
  try {
    await installation.createReview(scan.repo.fullName, scan.prNumber!, { commitId: scan.headSha, body, comments });
    return comments.length;
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 422) throw error;
    await captureException(error, { source: "publish", tags: { step: "inline_review", scan_id: scan.id }, handled: true });
    return 0;
  }
}

/**
 * Writes Sandchest's summary comment on the PR: edits the one it already
 * posted, or (with `create`) posts it. A summary someone deleted is posted
 * again. GitHub refusing it for good (permissions, a locked conversation)
 * is reported and skipped, so the Check still completes; anything transient
 * is thrown, and the step retries.
 */
async function postSummary(scan: LoadedScan, installation: Installation, body: string, options: { create: boolean }): Promise<void> {
  const prNumber = scan.prNumber!;
  try {
    const existing = await prComment(db(), scan.repo.id, prNumber);
    // Reviews of one PR can finish out of order: an older commit's never replaces a newer one's.
    if (existing?.describes && existing.describes > scan.createdAt) return;
    if (existing) {
      try {
        await installation.editComment(scan.repo.fullName, existing.commentId, body);
        await savePrComment(db(), { repoId: scan.repo.id, prNumber, commentId: existing.commentId, scanId: scan.id });
        return;
      } catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 404) throw error;
      }
    }
    if (!options.create) return;
    const commentId = await installation.comment(scan.repo.fullName, prNumber, body);
    await savePrComment(db(), { repoId: scan.repo.id, prNumber, commentId, scanId: scan.id });
  } catch (error) {
    const permanent = error instanceof GitHubError && error.status >= 400 && error.status < 500 && error.status !== 429;
    if (!permanent) throw error;
    await captureException(error, { source: "publish", tags: { step: "summary", scan_id: scan.id }, handled: true });
  }
}

/** A Boat sandbox that stops itself after `budgetMs`, unless SANDCHEST_BOAT_TTL_SECONDS says otherwise. */
export function openBoatWorkspace(budgetMs: number): Promise<BoatWorkspace> {
  const settings = config();
  return BoatWorkspace.create({
    apiKey: settings.SANDCHEST_BOAT_API_KEY!,
    type: settings.SANDCHEST_BOAT_TYPE,
    ttlSeconds: settings.SANDCHEST_BOAT_TTL_SECONDS ?? Math.ceil(budgetMs / 1000),
  });
}

/** The indexer the slice engine runs in its sandbox: its own build when one is set, else the one every sandbox scan uses. */
export function sliceIndexerBinary(): IndexerBinary {
  const settings = config();
  if (settings.SANDCHEST_SLICE_INDEXER_LINUX_URL && settings.SANDCHEST_SLICE_INDEXER_LINUX_SHA256) {
    return { url: settings.SANDCHEST_SLICE_INDEXER_LINUX_URL, sha256: settings.SANDCHEST_SLICE_INDEXER_LINUX_SHA256 };
  }
  return indexerBinary("boat");
}

export function indexerBinary(workspace: Config["workspace"]): IndexerBinary {
  const settings = config();
  if (workspace === "local") return { path: settings.SANDCHEST_INDEXER_BIN ?? "sandchest-index" };
  if (settings.SANDCHEST_INDEXER_LINUX_BIN) return { path: settings.SANDCHEST_INDEXER_LINUX_BIN };
  return { url: settings.SANDCHEST_INDEXER_LINUX_URL!, sha256: settings.SANDCHEST_INDEXER_LINUX_SHA256! };
}

/** A stored threat model, or undefined if missing or from an incompatible version. */
function parseThreatModel(value: unknown): ThreatModel | undefined {
  const parsed = ThreatModelSchema.partial().safeParse(value);
  return parsed.success && parsed.data.summary !== undefined ? (parsed.data as ThreatModel) : undefined;
}

export function toChangedFile(file: PullFile): ChangedFile {
  const status = file.status === "changed" || file.status === "unchanged" ? "modified" : file.status;
  return { path: file.filename, status, additions: file.additions, deletions: file.deletions, hunks: parsePatch(file.filename, file.patch).hunks, patch: file.patch };
}

function usageOf(usage: { inputTokens: number; cachedTokens: number; outputTokens: number; requests: number }) {
  return { inputTokens: usage.inputTokens, cachedTokens: usage.cachedTokens, outputTokens: usage.outputTokens, requests: usage.requests };
}

export function toFindingInput(finding: Finding): FindingInput {
  return {
    fingerprint: finding.fingerprint,
    severity: finding.severity,
    confidence: finding.confidence,
    category: finding.category,
    cwe: finding.cwe,
    title: finding.title,
    impact: finding.impact,
    mitigations: finding.mitigations,
    entryPoint: finding.entryPoint,
    attackPath: finding.attackPath,
    attacker: finding.attacker,
    preconditions: finding.preconditions,
    proofOfConcept: finding.proofOfConcept,
    fixGuidance: finding.fixGuidance,
    guarantees: finding.guarantees,
    mustNotBreak: finding.mustNotBreak,
    regressionTest: finding.regressionTest,
    fixPrompt: finding.fixPrompt,
    trust: finding.trust ?? null,
    sources: finding.sources ?? [],
    validation: finding.validation ?? null,
  };
}

function toEngineFinding(row: FindingRow): Finding & { id: string } {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    title: row.title,
    severity: row.severity,
    confidence: row.confidence,
    category: row.category as Finding["category"],
    cwe: row.cwe,
    impact: row.impact,
    mitigations: row.mitigations ?? "",
    entryPoint: row.entryPoint as Finding["entryPoint"],
    attackPath: row.attackPath as Finding["attackPath"],
    attacker: row.attacker as Finding["attacker"],
    preconditions: row.preconditions,
    proofOfConcept: row.proofOfConcept,
    fixGuidance: row.fixGuidance,
    guarantees: row.guarantees,
    mustNotBreak: row.mustNotBreak,
    regressionTest: row.regressionTest,
    fixPrompt: row.fixPrompt,
    leads: [],
    skeptic: { confidence: row.confidence, reasoning: "" },
    trust: row.trust ?? undefined,
    sources: row.sources ?? [],
    validation: (row.validation as Finding["validation"]) ?? undefined,
  };
}

/** Open findings citing a file the push changed (dependency findings when a manifest changed), and what it changed. A fix check's head is the pushed commit, never "HEAD". */
async function affectedFindings(scan: LoadedScan, installation: Installation): Promise<{ findings: FindingRow[]; changes: PullFile[] }> {
  const open = await openFindings(db(), scan.repo.id);
  if (open.length === 0) return { findings: [], changes: [] };
  const changes = await installation.compare(scan.repo.fullName, scan.baseSha ?? `${scan.headSha}~1`, scan.headSha);
  const changed = new Set(changes.map((f) => f.filename));
  // A dependency is fixed in a lockfile or manifest, not in the import the finding cites.
  const manifests = changes.some((f) => isDependencyManifest(f.filename));
  return { findings: open.filter((f) => citedFiles(f).some((file) => changed.has(file)) || (manifests && f.category === "vulnerable_dependency")), changes };
}

function citedFiles(finding: FindingRow): string[] {
  return [finding.entryPoint as { file: string }, ...(finding.attackPath as Array<{ file: string }>)].map((step) => step.file);
}

async function findingsById(ids: string[]): Promise<FindingRow[]> {
  if (ids.length === 0) return [];
  return db().query.findings.findMany({ where: (findings, { inArray }) => inArray(findings.id, ids) });
}
