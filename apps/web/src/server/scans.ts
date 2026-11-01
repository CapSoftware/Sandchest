/**
 * What each scan workflow step does. Steps pass ids only: no code or
 * finding text ever goes into workflow storage. Every write is idempotent,
 * because a step that dies is retried from the start.
 */
import { DEEP_SCAN_TIERS, deepScanCredits, prReviewCredits } from "@sandchest/billing";
import { criticalFindingEmail, deepScanEmail } from "@sandchest/email";
import {
  claimNotification,
  claimScanSlot,
  EventWriter,
  markDeepScanned,
  markFixed,
  markStale,
  notificationRecipients,
  openFindings,
  recordMetrics,
  saveThreatModel,
  scanById,
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
  changedLines,
  checkFixes,
  relevantChanges,
  runRecon,
  runScan,
  ScanRefusedError,
  storableLeads,
  ThreatModelSchema,
  type ChangedFile,
  type Finding,
  type ScanEvent,
  type ThreatModel,
} from "@sandchest/engine/scan";
import { checkResult, notReviewed, parsePatch, reviewBody, reviewComment, shown, type PullFile, type ReviewComment } from "@sandchest/github";
import type { IndexerBinary, Workspace } from "@sandchest/workspace";
import { LocalWorkspace } from "@sandchest/workspace/local";
import { SandboxWorkspace } from "@sandchest/workspace/sandbox";
import { billingEnabled, reserveScan, settleScan, syncBilling, type Gate } from "./billing";
import { config } from "./config";
import { db, githubApp, llmClient, mailer, osvClient, pricing } from "./services";

/** Concurrent scans per org (SPEC §4). */
export const ORG_CONCURRENCY = 2;
/** The engine's wall-clock budget inside a workflow step: under Vercel's 800 s function limit. */
const SCAN_BUDGET_MS = 12 * 60_000;
const CHECK_NAME = "Sandchest";

/** A scan's job is done; retries and duplicate starts must not redo it. */
export class ScanFinished extends Error {}

export type BeginResult = { state: "running" | "queued" | "done" };

/**
 * Lets the scan run (its credits held, or the org's plan checked), claims a
 * concurrency slot and, for PRs, posts the in-progress Check straight away.
 */
export async function beginScan(scanId: string): Promise<BeginResult> {
  const scan = await requireScan(scanId);
  if (["completed", "failed", "cancelled", "refused", "publishing"].includes(scan.status)) return { state: "done" };
  if (scan.status === "queued" && scan.billing === null && billingEnabled()) {
    const gate = await reserveScan(scan.id, { id: scan.orgId, githubLogin: scan.repo.org.githubLogin }, await scanCredits(scan));
    if (!gate.ok) {
      await refuse(scan, gate);
      return { state: "done" };
    }
  }
  if (!(await claimScanSlot(db(), scan.id, scan.orgId, ORG_CONCURRENCY))) return { state: "queued" };
  if (scan.kind === "pr_review" && !scan.checkRunId && scan.repo.org.installationId) {
    const checkRunId = await githubApp()
      .installation(scan.repo.org.installationId)
      .createCheckRun(scan.repo.fullName, {
        name: CHECK_NAME,
        headSha: scan.headSha,
        externalId: scan.id,
        detailsUrl: detailsUrl(scan.id),
        output: { title: "Digging…", summary: "Reviewing this change for exploitable vulnerabilities." },
      });
    await updateScan(db(), scan.id, { checkRunId });
  }
  return { state: "running" };
}

/** What a scan costs, before it runs. A PR review costs what the engine will report for the same files. */
async function scanCredits(scan: LoadedScan): Promise<number> {
  if (scan.kind === "deep") return deepScanCredits(scan.repo.loc ?? 0) ?? DEEP_SCAN_TIERS.at(-1)!.credits;
  if (scan.kind !== "pr_review" || !scan.prNumber || !scan.repo.org.installationId) return 0;
  const files = await githubApp().installation(scan.repo.org.installationId).pullFiles(scan.repo.fullName, scan.prNumber);
  const relevant = relevantChanges(files.map(toChangedFile));
  return relevant.length ? prReviewCredits(changedLines(relevant)) : 0;
}

/** A scan billing would not let run: recorded as refused, and a PR gets a neutral Check that never blocks merging. */
async function refuse(scan: LoadedScan, gate: Exclude<Gate, { ok: true }>): Promise<void> {
  const message = gate.reason === "no_plan" ? "Not run: this account has no plan." : `Not run: out of credits (needs ${gate.credits}).`;
  // The Check first: once the scan is marked refused, a retried step would never post it.
  let checkRunId = scan.checkRunId;
  if (scan.kind === "pr_review" && scan.repo.org.installationId) {
    const installation = githubApp().installation(scan.repo.org.installationId);
    const { conclusion, output } = notReviewed(gate.reason, `${appUrl()}/settings`, gate.credits);
    checkRunId ??= await installation.createCheckRun(scan.repo.fullName, { name: CHECK_NAME, headSha: scan.headSha, externalId: scan.id, output });
    await installation.completeCheckRun(scan.repo.fullName, checkRunId, conclusion, output);
  }
  await updateScan(db(), scan.id, { status: "refused", error: message, finishedAt: new Date(), checkRunId });
}

/** Clones, indexes and runs the engine; persists findings and the feed as they happen. */
export async function executeScan(scanId: string): Promise<{ findings: number }> {
  const scan = await requireScan(scanId);
  if (scan.status !== "running") return { findings: 0 };
  const installationId = scan.repo.org.installationId;
  if (!installationId || !scan.repo.enabled) throw new ScanFinished("Repository is no longer installed");

  const installation = githubApp().installation(installationId);
  const events = new EventWriter(db(), scan.id);
  const onEvent = (event: ScanEvent) => events.write(event.type, event.type === "finding" ? `Found: ${event.finding.title}` : event.message);
  const settings = config();
  const workspace: Workspace =
    settings.workspace === "sandbox" ? await SandboxWorkspace.create({ timeoutMs: SCAN_BUDGET_MS + 5 * 60_000 }) : await LocalWorkspace.create();

  try {
    const ref = scan.headSha === "HEAD" ? scan.repo.defaultBranch : scan.headSha;
    // Clone while the diff and the stored threat model load.
    const [, pullFiles, memory] = await Promise.all([
      installation.cloneToken(scan.repo.githubRepoId).then((token) => workspace.clone({ url: `${(settings.SANDCHEST_GIT_HOST ?? "https://github.com").replace(/\/$/, "")}/${scan.repo.fullName}.git`, ref }, { depth: 1, token })),
      scan.kind === "pr_review" && scan.prNumber ? installation.pullFiles(scan.repo.fullName, scan.prNumber) : Promise.resolve(undefined),
      storedThreatModel(db(), scan.repo.id),
    ]);
    const headSha = (await workspace.exec(["git", "rev-parse", "HEAD"])).stdout.trim();
    const handle = await workspace.startIndexer(indexerBinary(settings.workspace));
    const indexer = createIndexerClient({ url: handle.url, token: handle.token });
    const model = parseThreatModel(memory?.threatModel);
    const common = { client: llmClient(), indexer, osv: osvClient(), pricing: pricing(), onEvent, limits: { timeBudgetMs: SCAN_BUDGET_MS } };

    if (scan.kind === "recon") {
      const result = await runRecon(common);
      await saveThreatModel(db(), scan.repo.id, result.threatModel, headSha);
      await recordMetrics(db(), scan.id, { ...usageOf(result.usage), modelCostUsd: result.costUsd, durationMs: result.durationMs, candidates: 0, survivors: 0 });
      await updateScan(db(), scan.id, { stats: { loc: result.loc } });
      await setRepoLoc(db(), scan.repo.id, result.loc);
      return { findings: 0 };
    }

    if (scan.kind === "fix_check") {
      const open = await openFindings(db(), scan.repo.id);
      const changed = new Set((await installation.compare(scan.repo.fullName, scan.baseSha ?? `${headSha}~1`, headSha)).map((f) => f.filename));
      const affected = open.filter((f) => citedFiles(f).some((file) => changed.has(file)));
      if (affected.length === 0 || !model) return { findings: 0 };
      onEvent({ type: "progress", message: `Re-checking ${affected.length} open ${affected.length === 1 ? "finding" : "findings"} on the new code…` });
      const checkStarted = Date.now();
      const { results, usage, costUsd } = await checkFixes({ ...common, threatModel: model, findings: affected.map(toEngineFinding) });
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
      pullRequest: pullFiles ? { files: pullFiles.map(toChangedFile) } : undefined,
      onEvent,
    });
    if (!model) await saveThreatModel(db(), scan.repo.id, report.threatModel, headSha);
    const { ids, newIds } = await upsertFindings(db(), scan.repo.id, scan, report.findings.map(toFindingInput));
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
    if (error instanceof ScanRefusedError) {
      await updateScan(db(), scan.id, { status: "refused", error: error.message, finishedAt: new Date() });
      throw new ScanFinished(error.message);
    }
    if (error instanceof LlmQuotaError) throw new ScanFinished("The model provider refused for quota reasons; the scan is paused.");
    throw error;
  } finally {
    await Promise.allSettled([events.flush(), workspace.destroy()]);
  }
}

/** Completes the PR Check and posts the review. Other scans have nothing to publish. */
export async function publishScan(scanId: string): Promise<void> {
  const scan = await requireScan(scanId);
  if (scan.status === "completed") return;
  const installationId = scan.repo.org.installationId;
  if (scan.kind === "pr_review" && scan.checkRunId && scan.prNumber && installationId) {
    const installation = githubApp().installation(installationId);
    const stats = (scan.stats ?? {}) as { findingIds?: string[] };
    // A finding someone dismissed stays quiet when a later scan finds it again.
    const findings = (await findingsById(stats.findingIds ?? [])).filter((row) => row.status !== "dismissed").map(toEngineFinding);
    const visible = shown(findings);
    let inline = 0;
    // Private repos get the details inline; public repos only ever get the redacted Check.
    if (scan.repo.private && visible.length > 0) {
      const diffs = new Map((await installation.pullFiles(scan.repo.fullName, scan.prNumber)).map((f) => [f.filename, parsePatch(f.filename, f.patch)]));
      const comments: ReviewComment[] = [];
      const unplaced: Finding[] = [];
      for (const finding of visible) {
        // The sink first, then any other hop that is on a line in the diff.
        const spot = [...finding.attackPath].reverse().find((step) => diffs.get(step.file)?.commentable.has(step.line));
        if (spot) comments.push({ path: spot.file, line: spot.line, side: "RIGHT", body: reviewComment(finding) });
        else unplaced.push(finding);
      }
      inline = comments.length;
      await installation.createReview(scan.repo.fullName, scan.prNumber, { commitId: scan.headSha, body: reviewBody(visible, unplaced, detailsUrl(scan.id)), comments });
    }
    const threshold = scan.repo.org.settings.checkThreshold;
    const { conclusion, output } = checkResult({ findings, threshold, isPublic: !scan.repo.private, detailsUrl: detailsUrl(scan.id), credits: scan.credits, inline });
    await installation.completeCheckRun(scan.repo.fullName, scan.checkRunId, conclusion, output);
  }
  await updateScan(db(), scan.id, { status: "completed", finishedAt: new Date() });
  await charge(scan);
  // Email is best effort and at most once: it never fails or repeats a scan.
  await notifyScan(scan).catch((error: unknown) => console.error(`Notifications for scan ${scan.id} failed: ${error instanceof Error ? error.name : "error"}`));
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
  const summary = (row: FindingRow) => ({ title: row.title, severity: row.severity, url: `${base}/findings/${row.id}` });
  const order = ["critical", "high", "medium", "low"];
  const sorted = rows.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const email = scan.kind === "deep" ? deepScanEmail({ repo: scan.repo.fullName, scanUrl: detailsUrl(scan.id), findings: sorted.map(summary) }) : criticalFindingEmail({ repo: scan.repo.fullName, findings: critical.map(summary) });
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
    console.error(`Charging scan ${scan.id} failed: ${error instanceof Error ? error.message : "error"}`);
  }
}

/** Records a failure, gives back the scan's credits and never leaves a PR Check spinning. */
export async function failScan(scanId: string, message: string): Promise<void> {
  const scan = await requireScan(scanId);
  await settleScan(scan, "release").catch((error: unknown) => console.error(`Releasing scan ${scan.id} failed: ${error instanceof Error ? error.message : "error"}`));
  if (scan.status !== "refused") await updateScan(db(), scan.id, { status: "failed", error: message.slice(0, 2_000), finishedAt: new Date() });
  if (scan.kind === "pr_review" && scan.checkRunId && scan.repo.org.installationId) {
    await githubApp()
      .installation(scan.repo.org.installationId)
      .completeCheckRun(scan.repo.fullName, scan.checkRunId, "neutral", {
        title: scan.status === "refused" ? "Not reviewed" : "Review could not finish",
        summary: scan.status === "refused" ? message : "Sandchest could not finish this review. It does not block merging; push again to retry.",
      });
  }
}

type LoadedScan = NonNullable<Awaited<ReturnType<typeof scanById>>>;

async function requireScan(scanId: string): Promise<LoadedScan> {
  const scan = await scanById(db(), scanId);
  if (!scan) throw new ScanFinished(`Scan ${scanId} not found`);
  return scan;
}

function appUrl(): string {
  return config().SANDCHEST_APP_URL.replace(/\/$/, "");
}

function detailsUrl(scanId: string): string {
  return `${appUrl()}/scans/${scanId}`;
}

function indexerBinary(workspace: "sandbox" | "local"): IndexerBinary {
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

function toChangedFile(file: PullFile): ChangedFile {
  const status = file.status === "changed" || file.status === "unchanged" ? "modified" : file.status;
  return { path: file.filename, status, additions: file.additions, deletions: file.deletions, hunks: parsePatch(file.filename, file.patch).hunks, patch: file.patch };
}

function usageOf(usage: { inputTokens: number; cachedTokens: number; outputTokens: number; requests: number }) {
  return { inputTokens: usage.inputTokens, cachedTokens: usage.cachedTokens, outputTokens: usage.outputTokens, requests: usage.requests };
}

function toFindingInput(finding: Finding): FindingInput {
  return {
    fingerprint: finding.fingerprint,
    severity: finding.severity,
    confidence: finding.confidence,
    category: finding.category,
    cwe: finding.cwe,
    title: finding.title,
    impact: finding.impact,
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
  };
}

function citedFiles(finding: FindingRow): string[] {
  return [finding.entryPoint as { file: string }, ...(finding.attackPath as Array<{ file: string }>)].map((step) => step.file);
}

async function findingsById(ids: string[]): Promise<FindingRow[]> {
  if (ids.length === 0) return [];
  return db().query.findings.findMany({ where: (findings, { inArray }) => inArray(findings.id, ids) });
}
