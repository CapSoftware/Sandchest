/**
 * A deep scan on the slice engine, in workflow steps that each fit a function's time limit: hunt (open a
 * sandbox, select code, hunt and score from this server), a verification session and a variants session
 * run by an agent inside the sandbox (started by one step, polled and collected by later ones), then the
 * write-up, persisted as a classic deep scan is.
 *
 * A pull request review runs the same steps: its hunt reads the change from GitHub and opens a sandbox
 * only for candidates to verify, it has no variants session, and it is persisted as a classic review is.
 *
 * Steps take and return ids, enums and counts only. Between steps, the scan row's `stats.slice` holds ids
 * and numbers; the hunt result, the verdicts and the confirmed findings stay inside the sandbox, in a
 * directory only its own user can enter, so no code or finding text reaches workflow storage.
 */
import { createHash } from "node:crypto";
import { deepScanCredits, prReviewCredits } from "@sandchest/billing";
import { usdToMicroUsd } from "@sandchest/billing/usage";
import {
  endStage,
  EventWriter,
  insertUsage,
  knownFindings,
  markDeepScanned,
  nextUsageAttempt,
  recordMetrics,
  recordStage,
  scanById,
  scanStageRows,
  scanUsageTotals,
  setComputeCost,
  startStage,
  updateScan,
  upsertFindings,
  usageBudgetState,
  type StageOutcome,
} from "@sandchest/db";
import { LlmQuotaError } from "@sandchest/engine/llm";
import { adoptKnownFingerprints, changedLines, DEFAULT_LIMITS, relevantChanges, ScanRefusedError, slice, UnpricedCallError, type Finding, type ScanEvent, type ScanReport, type UsageSink } from "@sandchest/engine/scan";
import { parsePatch, type Installation } from "@sandchest/github";
import type { IndexerBinary, IndexerHandle } from "@sandchest/workspace";
import { agentSandboxSetupScript, bulkReadFiles } from "@sandchest/workspace/boat";
import { config, fastModeAvailable, fastRunAllowed } from "./config";
import { captureFromScan } from "./cves";
import { gatewayEndpoint, mintGatewayToken, STALE_CALL_SECONDS } from "./gateway";
import { describeError } from "./log";
import { noticeScanPaused } from "./notices";
import { sliceIndexerBinary, isEmptyRepoError, prepareWorkspace, publishScan, requireScan, ScanFinished, toChangedFile, toFindingInput, type LoadedScan } from "./scans";
import { captureException } from "./sentry";
import { db, githubApp, sliceClient, sliceRuntime } from "./services";
import { SandboxGone, type SliceSandbox } from "./slice-runtime";
import { readSandboxUsage, UsageLedger } from "./usage-ledger";

/** The sandbox stops itself this long after it is made, or after a session last started, if nothing deletes it. */
export const SLICE_TTL_SECONDS = 90 * 60;
/** The one loopback port the agent may reach: its relay to the gateway. */
export const RELAY_PORT = 4100;
/** A session's gateway token outlives the longest a session is polled. */
const SESSION_TOKEN_TTL_SECONDS = 60 * 60;
/** The hunt step stops spending after this long, under the function's 800 s limit. */
const HUNT_BUDGET_MS = 12 * 60_000;
/** A pull request's hunt is shorter: the sandbox opens after it, in the same step. */
const CHANGE_HUNT_BUDGET_MS = 8 * 60_000;
/** Write-ups still running this long into the write-up step are dropped, leaving time to persist. */
const WRITEUP_BUDGET_MS = 10 * 60_000;
const CLONE_TIMEOUT_MS = 4 * 60_000;

/** The sandbox's private files. */
const FILES = { hunt: "slice-hunt.json", verify: "slice-verify.json", confirmed: "slice-confirmed.json", variants: "slice-variants.json" } as const;

export type SessionKind = "verify" | "variants";

interface SessionState extends slice.AgentSessionIds {
  /** The gateway token's attempt, also the stage's. */
  attempt: number;
  startedAt: number;
  collected?: boolean;
  verdicts?: number;
  real?: number;
}

/** What `stats.slice` holds: ids and numbers only. */
export interface SliceState {
  sandboxId?: string;
  /** The hunt run that made the sandbox: its cost is recorded under it. */
  huntAttempt?: number;
  loc?: number;
  selected?: number;
  /** A pull request's changed server files left out of the hunt: no patch, or no readable text. */
  skipped?: number;
  sessions?: Partial<Record<SessionKind, SessionState>>;
  /** Findings written by the write-up; set once they are persisted. */
  findings?: number;
  written?: boolean;
  /** Set by the hunt of a scan flagged fast: whether it runs fast. Every later step follows it. */
  fast?: boolean;
}

/** The scan's spend reached SANDCHEST_SLICE_CEILING_USD. */
export class SpendCeilingReached extends Error {
  override readonly name = "SpendCeilingReached";
  constructor() {
    super("The scan reached its spending ceiling");
  }
}

const CEILING_MESSAGE = "The scan reached its spending ceiling, so it was stopped. Nothing was charged.";
const FAST_UNAVAILABLE = "Fast mode is not available right now, so this scan runs at standard speed.";

// ---- Hunt ---------------------------------------------------------------------

/**
 * Opens the sandbox (clone, indexer, agent CLI), runs the slice hunt and keeps its result in the sandbox.
 * A pull request is hunted from its change on GitHub first, and gets a sandbox only when something was
 * selected. A run of this step that is retried first deletes the sandbox the earlier run left. Returns how
 * many candidates were selected for verification, and whether a variants session follows it.
 */
export async function huntSlice(scanId: string, run: { attempt?: number; /** For tests. Default the engine's. */ passDelayMs?: number } = {}): Promise<{ selected: number; variants: boolean }> {
  const scan = await requireScan(scanId);
  // A pull request is verified, never searched for variants.
  const variants = scan.kind !== "pr_review";
  if (scan.status !== "running") return { selected: 0, variants };
  const installationId = scan.repo.org.installationId;
  if (!installationId || !scan.repo.enabled) throw new ScanFinished("Repository is no longer installed");
  const runtime = sliceRuntime();
  const installation = githubApp().installation(installationId);

  const attempt = Math.max(await nextUsageAttempt(db(), scan.id, "hunt"), run.attempt ?? 0);
  const stages = new StageRecorder(scan.id);
  if (scan.startedAt) stages.record("queue", 0, scan.createdAt, scan.startedAt, "ok");
  // A retry starts over: the earlier run's sandbox goes first, its cost recorded under that run.
  await releaseSandbox(scan.id, sliceState(scan));

  const events = new EventWriter(db(), scan.id);
  const ledger = new UsageLedger({ scanId: scan.id, write: (rows) => insertUsage(db(), scan.id, rows), step: "hunt", attempt });
  const fast = runsFast(scan);
  const guard = await spendGuard(scan, ledger, fast);
  const started = Date.now();
  let inventory: ReturnType<typeof captureFromScan> | undefined;
  try {
    if (guard.signal.aborted) throw guard.signal.reason;
    if (scan.fast && !fast && sliceState(scan).fast === undefined) events.write("progress", FAST_UNAVAILABLE);
    if (scan.kind === "pr_review") return { selected: await huntChange({ scan, installation, attempt, stages, events, guard, passDelayMs: run.passDelayMs }), variants };
    events.write("stage:setup", "Starting a fresh sandbox and fetching the code…");
    const { sandbox, headSha, handle } = await openSandbox({ scan, installation, attempt, stages, events, started, fast: scan.fast ? fast : undefined });
    const indexer = runtime.indexer(handle);

    // Lines of code as the classic engine measures them, for the charge and the size limit.
    events.write("stage:index", "Indexing the code and choosing what to hunt in…");
    const { loc } = await indexer.call<{ loc: number }>("overview", {});
    if (loc > DEFAULT_LIMITS.maxLoc) throw new ScanRefusedError(`This repository has ${loc.toLocaleString("en")} lines of code; the limit is ${DEFAULT_LIMITS.maxLoc.toLocaleString("en")}.`);
    // The CVE directory's inventory, read from the default branch while the hunt runs, as a classic deep scan does.
    inventory = captureFromScan(scan.repo.id, headSha, scan.headSha === "HEAD" ? new Date(started) : scan.createdAt, indexer);

    const files = checkoutFiles(sandbox);
    const result = await slice.runSliceHunt({
      client: sliceClient(fast),
      indexer,
      listFiles: files.list,
      readFile: files.read,
      signal: AbortSignal.any([guard.signal, AbortSignal.timeout(HUNT_BUDGET_MS)]),
      onUsage: guard.onUsage,
      requireCost: true,
      passDelayMs: run.passDelayMs,
      onProgress: (message) => events.write("progress", message),
      onPhase: (phase, startedAt, endedAt, ok) => {
        stages.record(phase, attempt, new Date(startedAt), new Date(endedAt), ok ? "ok" : "failed");
        if (phase === "select" && ok) events.write("stage:hunt", "Hunting through the selected code…");
      },
    });
    if (guard.signal.aborted) throw guard.signal.reason;

    await sandbox.writePrivateFiles([{ name: FILES.hunt, content: JSON.stringify({ findings: result.findings, candidates: result.candidates }) }]);
    const selected = result.findings.length;
    await saveSlice(scan.id, { loc, selected });
    events.write("progress", selected === 0 ? "Nothing worth verifying turned up." : `${selected} ${selected === 1 ? "candidate goes" : "candidates go"} to verification.`);
    return { selected, variants };
  } catch (error) {
    return await stopped(scan, error, guard.signal);
  } finally {
    await inventory?.read;
    await Promise.allSettled([events.flush(), inventory?.done, closeLedger(scan.id, ledger), stages.flush()]);
  }
}

/**
 * A pull request's hunt: its changed server files and their changed lines from GitHub, the file text at the
 * head commit, the change-review hunt. With candidates, the sandbox is opened (as for a deep scan, at the
 * head commit) and keeps the result; with none, no sandbox is made. The review that sets the charge goes
 * in `stats.review`, built as the classic engine builds it.
 */
async function huntChange(input: {
  scan: LoadedScan;
  installation: Installation;
  attempt: number;
  stages: StageRecorder;
  events: EventWriter;
  guard: { onUsage: UsageSink; signal: AbortSignal };
  passDelayMs?: number;
}): Promise<number> {
  const { scan, installation, attempt, stages, events, guard } = input;
  if (!scan.prNumber) throw new ScanFinished("The review has no pull request");
  // No sandbox from an earlier run is left to find.
  await saveSlice(scan.id, { huntAttempt: attempt }, { replace: true });
  events.write("stage:setup", "Reading the change…");
  const signal = AbortSignal.any([guard.signal, AbortSignal.timeout(CHANGE_HUNT_BUDGET_MS)]);
  const fetched = Date.now();
  const pullFiles = await installation.pullFiles(scan.repo.fullName, scan.prNumber, signal);
  const relevant = relevantChanges(pullFiles.map(toChangedFile));
  const changes = pullFiles.map((file) => ({ path: file.filename, additions: file.additions, ranges: parsePatch(file.filename, file.patch).changed }));
  // The files the hunt takes. One whose patch GitHub left out (too large) has no changed lines, and is not hunted.
  const server = slice.changedServerPaths(changes);
  const hunted = changes.filter((change) => change.ranges.length > 0 && server.includes(change.path)).map((change) => change.path);
  const noPatch = server.filter((file) => !hunted.includes(file));
  const texts = readChangedFiles(hunted, (file) => installation.fileAt(scan.repo.fullName, file, scan.headSha, signal));
  if (server.length === 0) events.write("progress", "No server-side changes to review.");

  const result = await slice.runChangeHunt({
    client: sliceClient(),
    changes,
    readFile: (file) => texts.get(file) ?? Promise.resolve(undefined),
    signal,
    onUsage: guard.onUsage,
    requireCost: true,
    passDelayMs: input.passDelayMs,
    onProgress: (message) => events.write("progress", message),
    onPhase: (phase, startedAt, endedAt, ok) => {
      // Reading the change from GitHub is part of choosing what to hunt.
      stages.record(phase, attempt, new Date(phase === "select" ? Math.min(startedAt, fetched) : startedAt), new Date(endedAt), ok ? "ok" : "failed");
      if (phase === "select" && ok && server.length > 0) events.write("stage:hunt", "Hunting through the changed code…");
    },
  });
  if (guard.signal.aborted) throw guard.signal.reason;
  const unread = (await Promise.all(hunted.map(async (file) => ((await texts.get(file)) === undefined ? file : undefined)))).filter((file) => file !== undefined);
  const skippedFiles = [...noPatch, ...unread];
  if (skippedFiles.length > 0) events.write("progress", `${skippedFiles.length} changed ${skippedFiles.length === 1 ? "file was" : "files were"} too large or could not be read, and ${skippedFiles.length === 1 ? "was" : "were"} left out.`);
  // `files` and `changedLines` as the classic engine reports them, so the charge is the one `scanCredits` reserved.
  const review: PrReview = { files: relevant.length, changedLines: changedLines(relevant), reviewedFiles: hunted.filter((file) => !unread.includes(file)), skippedFiles };
  await saveStats(scan.id, { review });

  const selected = result.findings.length;
  if (selected === 0) {
    await saveSlice(scan.id, { selected: 0, skipped: skippedFiles.length });
    events.write("progress", "Nothing worth verifying turned up.");
    return 0;
  }
  events.write("progress", `${selected} ${selected === 1 ? "candidate goes" : "candidates go"} to verification. Starting a sandbox…`);
  const { sandbox } = await openSandbox({ scan, installation, attempt, stages, events, started: Date.now() });
  await sandbox.writePrivateFiles([{ name: FILES.hunt, content: JSON.stringify({ findings: result.findings, candidates: result.candidates }) }]);
  await saveSlice(scan.id, { selected, skipped: skippedFiles.length });
  return selected;
}

/** Every changed file's text at the head commit, a few at a time; one that cannot be read is undefined. */
function readChangedFiles(files: string[], read: (file: string) => Promise<string | undefined>, concurrency = 8): Map<string, Promise<string | undefined>> {
  const texts = new Map<string, Promise<string | undefined>>();
  let active = 0;
  const waiting: Array<() => void> = [];
  for (const file of files) {
    texts.set(
      file,
      (async () => {
        if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
        else active++;
        try {
          return await read(file);
        } catch (error) {
          console.error(`A changed file could not be read: ${describeError(error)}`);
          return undefined;
        } finally {
          const next = waiting.shift();
          if (next) next();
          else active--;
        }
      })(),
    );
  }
  return texts;
}

/**
 * A fresh sandbox with the scan's commit checked out, the indexer running and the agent CLI installed,
 * timed as the `sandbox` stage. Recorded in `stats.slice` the moment it exists, with `fast` when given.
 */
async function openSandbox(input: { scan: LoadedScan; installation: Installation; attempt: number; stages: StageRecorder; events: EventWriter; started: number; fast?: boolean }): Promise<{ sandbox: SliceSandbox; headSha: string; handle: IndexerHandle }> {
  const { scan, installation, attempt, stages, events } = input;
  const settings = config();
  const runtime = sliceRuntime();
  stages.start("sandbox", attempt);
  const url = `${(settings.SANDCHEST_GIT_HOST ?? "https://github.com").replace(/\/$/, "")}/${scan.repo.fullName}.git`;
  try {
    let opened: SliceSandbox | undefined;
    const ready = await prepareWorkspace({
      open: async () => {
        opened = await runtime.open({ ttlSeconds: SLICE_TTL_SECONDS, setupScript: agentSandboxSetupScript({ allowHosts: [], loopbackPorts: [RELAY_PORT], dns: false }) });
        // Recorded before anything else, so a later step can always find it and delete it.
        try {
          await saveSlice(scan.id, { sandboxId: opened.id, huntAttempt: attempt, ...(input.fast !== undefined && { fast: input.fast }) }, { replace: true });
        } catch (error) {
          await opened.destroy().catch(() => {});
          throw error;
        }
        return opened;
      },
      clone: async (workspace) => workspace.clone({ url, ref: scan.headSha }, { depth: 1, token: await installation.cloneToken(scan.repo.githubRepoId), timeoutMs: CLONE_TIMEOUT_MS }),
      binary: sliceIndexerBinary(),
      started: input.started,
      onRetry: (message) => events.write("progress", message),
    });
    const prepared = { sandbox: ready.workspace as SliceSandbox, headSha: ready.headSha, handle: ready.handle };
    await runtime.prepareAgentSandbox(prepared.sandbox);
    stages.end("sandbox", attempt, "ok");
    return prepared;
  } catch (error) {
    stages.end("sandbox", attempt, "failed");
    throw error;
  }
}

// ---- Sessions -----------------------------------------------------------------

/**
 * Starts the verification or variants session, once: a session already recorded for that kind is not
 * started again. False when there is nothing to start. A variants session that cannot start never fails
 * the scan.
 */
export async function startSliceSession(scanId: string, kind: SessionKind): Promise<{ started: boolean }> {
  const scan = await requireScan(scanId);
  if (scan.status !== "running") return { started: false };
  const state = sliceState(scan);
  if (state.sessions?.[kind]) return { started: true };
  const stages = new StageRecorder(scan.id);
  const events = new EventWriter(db(), scan.id);
  let attempt: number | undefined;
  try {
    const fast = runsFast(scan);
    const { ceilingMicroUsd, secret } = sliceLimits(scan.kind, fast);
    const budget = await usageBudgetState(db(), scan.id, STALE_CALL_SECONDS);
    if (budget && usdToMicroUsd(budget.spentUsd) >= ceilingMicroUsd) throw new SpendCeilingReached();
    const sandbox = await sliceRuntime().attach(requireSandboxId(state));
    let findings: unknown[];
    if (kind === "verify") {
      findings = (await readHunt(sandbox)).findings;
    } else {
      findings = parseJson<slice.ConfirmedEntry[]>(await sandbox.readPrivateFile(FILES.confirmed)) ?? [];
      if (findings.length === 0) {
        stages.record("variants", 0, new Date(), new Date(), "skipped");
        return { started: false };
      }
    }
    // Keeps the sandbox alive for the whole session: it would otherwise stop at its first deadline.
    await sandbox.extendTtl(SLICE_TTL_SECONDS);
    attempt = await nextUsageAttempt(db(), scan.id, kind);
    const token = mintGatewayToken({ scanId: scan.id, stage: kind, attempt, ceilingMicroUsd, ttlSeconds: SESSION_TOKEN_TTL_SECONDS, ...(fast && { fast: true }) }, secret);
    const startedAt = Date.now();
    stages.start(kind, attempt, new Date(startedAt));
    const ids = await sliceRuntime().startAgentSession(sandbox, {
      kind: kind === "verify" ? "refute" : "variants",
      findings,
      relay: { port: RELAY_PORT, targetUrl: gatewayEndpoint(config().SANDCHEST_APP_URL).baseUrl, token },
    });
    await saveSlice(scan.id, { sessions: { ...state.sessions, [kind]: { relayProcessId: ids.relayProcessId, agentProcessId: ids.agentProcessId, attempt, startedAt } } });
    events.write(
      "stage:verify",
      kind === "verify"
        ? `Verifying ${findings.length} ${findings.length === 1 ? "candidate" : "candidates"} against the code in the sandbox…`
        : `Looking for the same flaw elsewhere, from ${findings.length} confirmed ${findings.length === 1 ? "finding" : "findings"}…`,
    );
    return { started: true };
  } catch (error) {
    if (attempt !== undefined) stages.end(kind, attempt, "failed");
    if (kind === "verify") return await stopped(scan, error);
    if (error instanceof ScanFinished || error instanceof SpendCeilingReached) return await stopped(scan, error);
    console.error(`Variants session for scan ${scan.id} did not start: ${describeError(error)}`);
    events.write("progress", "Could not look for variants; carrying on with what was verified.");
    return { started: false };
  } finally {
    await Promise.allSettled([events.flush(), stages.flush()]);
  }
}

/**
 * Where a session is. When it has ended, its stage ends at the exit marker's time in the sandbox, or at
 * this step's clock when that cannot be read. A scan no longer running reads as finished, so the
 * workflow moves on to steps that only clean up.
 */
export async function sliceSessionStatus(scanId: string, kind: SessionKind): Promise<{ state: "running" | "finished" | "failed" }> {
  const scan = await requireScan(scanId);
  if (scan.status !== "running") return { state: "finished" };
  const session = sliceState(scan).sessions?.[kind];
  if (!session) return { state: "failed" };
  const stages = new StageRecorder(scan.id);
  try {
    const sandbox = await sliceRuntime().attach(requireSandboxId(sliceState(scan)));
    const state = await sliceRuntime().agentSessionStatus(sandbox, session);
    if (state === "finished") stages.end(kind, session.attempt, "ok", await sessionEndedAt(sandbox, session.startedAt));
    if (state === "failed") stages.end(kind, session.attempt, "failed");
    return { state };
  } catch (error) {
    if (kind === "verify") return await stopped(scan, error);
    console.error(`Variants session status for scan ${scan.id} could not be read: ${describeError(error)}`);
    stages.end(kind, session.attempt, "failed");
    return { state: "failed" };
  } finally {
    await stages.flush();
  }
}

/**
 * Stops the session (if it still runs) and keeps its verdicts in the sandbox's private directory. Collected
 * once: a repeat returns what was counted. `timedOut` ends the session's stage as failed. A verification
 * that left no usable verdicts fails the scan; a variants session never does.
 */
export async function collectSliceSession(scanId: string, kind: SessionKind, options: { timedOut?: boolean } = {}): Promise<{ real: number }> {
  const scan = await requireScan(scanId);
  if (scan.status !== "running") return { real: 0 };
  const state = sliceState(scan);
  const session = state.sessions?.[kind];
  if (!session) return { real: 0 };
  if (session.collected) return { real: session.real ?? 0 };
  const stages = new StageRecorder(scan.id);
  const events = new EventWriter(db(), scan.id);
  try {
    const runtime = sliceRuntime();
    const sandbox = await runtime.attach(requireSandboxId(state));
    const result = await runtime.collectAgentSession(sandbox, session);
    if (options.timedOut) stages.end(kind, session.attempt, "failed");
    let real: number;
    if (kind === "verify") {
      if (result.verdicts.length === 0 && result.error !== undefined) {
        console.error(`Verification for scan ${scan.id} left no verdicts: ${result.error.slice(0, 200)}`);
        throw new ScanFinished("The verification in the sandbox ended without a result. Nothing was charged.");
      }
      const hunt = await readHunt(sandbox);
      const confirmed = slice.confirmedEntries(hunt.findings, result.verdicts, { checkoutRoot: sandbox.root });
      await sandbox.writePrivateFiles([
        { name: FILES.verify, content: JSON.stringify(result.verdicts) },
        { name: FILES.confirmed, content: JSON.stringify(confirmed) },
      ]);
      real = confirmed.length;
      events.write("progress", `Verified ${hunt.findings.length}: ${real} confirmed.`);
    } else {
      await sandbox.writePrivateFiles([{ name: FILES.variants, content: JSON.stringify(result.verdicts) }]);
      real = result.verdicts.filter((v) => v.verdict === "real").length;
      events.write("progress", real === 0 ? "No variants found." : `${real} ${real === 1 ? "variant" : "variants"} found.`);
    }
    await saveSlice(scan.id, { sessions: { ...state.sessions, [kind]: { ...session, collected: true, verdicts: result.verdicts.length, real } } });
    return { real };
  } catch (error) {
    if (kind === "verify") return await stopped(scan, error);
    console.error(`Variants session for scan ${scan.id} could not be collected: ${describeError(error)}`);
    stages.end(kind, session.attempt, "failed");
    return { real: 0 };
  } finally {
    await Promise.allSettled([events.flush(), stages.flush()]);
  }
}

// ---- Write-up -----------------------------------------------------------------

/**
 * Writes up what the agent confirmed, persists it as a classic deep scan or PR review does, records the
 * sandbox's cost and deletes the sandbox. With nothing confirmed, the scan completes with no findings the
 * same way. A pull request whose hunt selected nothing has no sandbox.
 */
export async function writeUpSlice(scanId: string, run: { attempt?: number } = {}): Promise<{ findings: number }> {
  const scan = await requireScan(scanId);
  const state = sliceState(scan);
  // Failed elsewhere while this ran, or written already by an earlier run of this step: only the sandbox is left to clean up.
  if (scan.status !== "running" || state.written) {
    await releaseSandbox(scan.id, state);
    return { findings: state.findings ?? 0 };
  }
  const attempt = Math.max(await nextUsageAttempt(db(), scan.id, "writeup"), run.attempt ?? 0);
  const stages = new StageRecorder(scan.id);
  const events = new EventWriter(db(), scan.id);
  const ledger = new UsageLedger({ scanId: scan.id, write: (rows) => insertUsage(db(), scan.id, rows), step: "writeup", attempt });
  const fast = runsFast(scan);
  const guard = await spendGuard(scan, ledger, fast);
  const started = Date.now();
  stages.start("writeup", attempt, new Date(started));
  try {
    if (guard.signal.aborted) throw guard.signal.reason;
    const review = scan.kind === "pr_review" ? (scan.stats as { review?: PrReview } | null)?.review : undefined;
    if (scan.kind === "pr_review" ? review === undefined : state.loc === undefined) throw new Error("The scan has no measured size");
    const runtime = sliceRuntime();
    const sandbox = scan.kind === "pr_review" && !state.sandboxId ? undefined : await runtime.attach(requireSandboxId(state));
    const sessions = state.sessions ?? {};
    let findings: Finding[] = [];
    if (sandbox && (sessions.verify?.real ?? 0) > 0) {
      const hunt = await readHunt(sandbox);
      const verdicts = parseJson<slice.Verdict[]>(await sandbox.readPrivateFile(FILES.verify)) ?? [];
      const variants = sessions.variants?.collected
        ? { verdicts: parseJson<slice.Verdict[]>(await sandbox.readPrivateFile(FILES.variants)) ?? [], confirmed: parseJson<slice.ConfirmedEntry[]>(await sandbox.readPrivateFile(FILES.confirmed)) ?? [] }
        : undefined;
      events.write("stage:verify", "Writing up what was confirmed…");
      const indexer = runtime.indexer(await restartIndexer(sandbox, sliceIndexerBinary()));
      const out = await slice.writeUpVerdicts({
        client: sliceClient(fast),
        indexer,
        findings: hunt.findings,
        candidates: hunt.candidates,
        verdicts,
        variants,
        checkoutRoot: sandbox.root,
        signal: guard.signal,
        deadline: started + WRITEUP_BUDGET_MS,
        onUsage: guard.onUsage,
        requireCost: true,
        onEvent: (event) => writeEvent(events, event),
      });
      if (guard.signal.aborted) throw guard.signal.reason;
      findings = out.findings;
      stages.end("writeup", attempt, "ok");
    } else {
      stages.end("writeup", attempt, "skipped");
    }

    // As `executeScan` persists a deep scan or a PR review.
    const recognised = adoptKnownFingerprints(findings, await knownFindings(db(), scan.repo.id));
    const { ids, newIds } = await upsertFindings(db(), scan.repo.id, scan, recognised.map(toFindingInput));
    const credits = review ? (review.files ? prReviewCredits(review.changedLines) : 0) : (deepScanCredits(state.loc!) ?? 0);
    await closeLedger(scan.id, ledger);
    const model = (await scanUsageTotals(db(), scan.id)).filter((total) => total.kind === "model");
    await recordMetrics(db(), scan.id, {
      inputTokens: model.reduce((sum, t) => sum + t.inputTokens, 0),
      cachedTokens: model.reduce((sum, t) => sum + t.cachedTokens, 0),
      outputTokens: model.reduce((sum, t) => sum + t.outputTokens, 0),
      requests: model.reduce((sum, t) => sum + t.requests, 0),
      modelCostUsd: model.reduce((sum, t) => sum + Number(t.costUsd), 0),
      durationMs: Date.now() - (scan.startedAt ?? scan.createdAt).getTime(),
      candidates: state.selected ?? 0,
      survivors: ids.length,
    });
    const written: SliceState = { ...state, findings: ids.length, written: true };
    if (review) {
      await updateScan(db(), scan.id, { credits, stats: { findingIds: ids, newFindingIds: newIds, review, slice: written } });
    } else {
      await updateScan(db(), scan.id, { credits, stats: { findingIds: ids, newFindingIds: newIds, loc: state.loc, slice: written } });
      await markDeepScanned(db(), scan.repo.id, new Date(), state.loc!);
    }
    events.write("stage:done", summary(findings));
    // The scan's result is stored: a sandbox that will not go now is reported and left to its time-to-live, never a reason to fail the scan.
    await releaseSandbox(scan.id, written, sandbox).catch(async (error: unknown) => {
      console.error(`Releasing the sandbox of scan ${scan.id} failed: ${describeError(error)}`);
      await captureException(error, { source: "workflow", tags: { step: "slice_release", scan_id: scan.id }, handled: true });
    });
    return { findings: ids.length };
  } catch (error) {
    stages.end("writeup", attempt, "failed");
    return await stopped(scan, error, guard.signal);
  } finally {
    await Promise.allSettled([events.flush(), closeLedger(scan.id, ledger), stages.flush()]);
  }
}

/** The existing publish, timed as the `publish` stage. */
export async function publishSlice(scanId: string): Promise<void> {
  const stages = new StageRecorder(scanId);
  stages.start("publish", 0);
  try {
    await publishScan(scanId);
    stages.end("publish", 0, "ok");
  } finally {
    await stages.flush();
  }
}

/**
 * Before the fail step: deletes the scan's sandbox, if there is one, after recording its cost, and ends
 * any stage left open as failed. Never throws, so the fail step always runs.
 */
export async function cleanUpSlice(scanId: string): Promise<void> {
  try {
    const scan = await scanById(db(), scanId);
    if (!scan) return;
    await releaseSandbox(scan.id, sliceState(scan));
    const open = (await scanStageRows(db(), scan.id)).filter((row) => row.endedAt === null);
    const stages = new StageRecorder(scan.id);
    for (const row of open) stages.end(row.stage, row.attempt, "failed");
    await stages.flush();
  } catch (error) {
    console.error(`Cleaning up slice scan ${scanId} failed: ${describeError(error)}`);
    await captureException(error, { source: "workflow", tags: { step: "slice_cleanup", scan_id: scanId }, handled: true });
  }
}

// ---- Pieces -------------------------------------------------------------------

/** How a step that went wrong ends: the expected endings finish the scan for good, anything else is retried. */
async function stopped(scan: LoadedScan, error: unknown, signal?: AbortSignal): Promise<never> {
  if (error instanceof SpendCeilingReached || (signal?.aborted && signal.reason instanceof SpendCeilingReached)) throw new ScanFinished(CEILING_MESSAGE);
  if (error instanceof ScanFinished) throw error;
  if (error instanceof ScanRefusedError || (scan.headSha === "HEAD" && isEmptyRepoError(error))) {
    const message = error instanceof ScanRefusedError ? error.message : "Nothing to scan yet: the repository has no commits.";
    await updateScan(db(), scan.id, { status: "refused", error: message, finishedAt: new Date() });
    throw new ScanFinished(message);
  }
  if (error instanceof LlmQuotaError) {
    await noticeScanPaused(scan).catch((failure: unknown) => console.error(`Scan-paused email for scan ${scan.id} failed: ${describeError(failure)}`));
    throw new ScanFinished("The model provider refused for quota reasons; the scan is paused.");
  }
  if (error instanceof UnpricedCallError) throw new ScanFinished("A model call reported no cost, so the scan was stopped.");
  if (error instanceof SandboxGone) throw new ScanFinished("The scan's sandbox is gone, so the scan was stopped. Nothing was charged.");
  throw error;
}

/**
 * Whether this step runs fast. The hunt of a scan flagged fast decides, from the flag and the settings, and
 * records the answer in `stats.slice`; every later step, and a retried hunt, follows that record, so a run
 * never changes mode halfway. A fast run whose fast settings are gone stops, as a run whose ceiling is gone does.
 */
function runsFast(scan: LoadedScan): boolean {
  const recorded = sliceState(scan).fast;
  if (recorded === undefined) return fastRunAllowed(scan, scan.repo.org.githubLogin);
  if (recorded && !fastModeAvailable()) throw new ScanFinished("The slice engine is no longer configured.");
  return recorded;
}

/** The scan's ceiling (a fast run's, a pull request's own, or a deep scan's) and the gateway secret. */
function sliceLimits(kind: string, fast: boolean): { ceilingMicroUsd: number; secret: string } {
  const settings = config();
  const ceiling = fast ? settings.SANDCHEST_SLICE_CEILING_FAST_USD : kind === "pr_review" ? settings.SANDCHEST_SLICE_CEILING_PR_USD : settings.SANDCHEST_SLICE_CEILING_USD;
  if (!ceiling || !settings.SANDCHEST_GATEWAY_SECRET) throw new ScanFinished("The slice engine is no longer configured.");
  return { ceilingMicroUsd: usdToMicroUsd(ceiling), secret: settings.SANDCHEST_GATEWAY_SECRET };
}

/**
 * The ledger's sink, adding each call's cost to what the scan had spent when the step began. At the
 * ceiling it aborts the returned signal, which the engine is given: no further call starts.
 */
async function spendGuard(scan: { id: string; kind: string }, ledger: UsageLedger, fast: boolean): Promise<{ onUsage: UsageSink; signal: AbortSignal }> {
  const scanId = scan.id;
  const { ceilingMicroUsd } = sliceLimits(scan.kind, fast);
  const budget = await usageBudgetState(db(), scanId, STALE_CALL_SECONDS);
  let spent = budget ? usdToMicroUsd(budget.spentUsd) : 0;
  const controller = new AbortController();
  if (spent >= ceilingMicroUsd) controller.abort(new SpendCeilingReached());
  return {
    signal: controller.signal,
    onUsage: (event) => {
      ledger.onUsage(event);
      try {
        spent += usdToMicroUsd(event.costUsd);
      } catch {
        // A cost that is not a non-negative amount: stop rather than spend on unknown terms.
        spent = ceilingMicroUsd;
      }
      if (spent >= ceilingMicroUsd && !controller.signal.aborted) controller.abort(new SpendCeilingReached());
    },
  };
}

async function closeLedger(scanId: string, ledger: UsageLedger): Promise<void> {
  const { unwritten } = await ledger.close();
  if (unwritten === 0) return;
  console.error(`Usage ledger for scan ${scanId}: ${unwritten} rows not written`);
  await captureException(Object.assign(new Error("Usage ledger rows were not written"), { name: "UsageLedgerUnwritten" }), { source: "billing", tags: { scan_id: scanId, rows: unwritten }, handled: true });
}

/**
 * Deletes the scan's sandbox after recording what it cost, once per sandbox. One already gone has nothing
 * to record or delete.
 */
async function releaseSandbox(scanId: string, state: SliceState, open?: SliceSandbox): Promise<void> {
  if (!state.sandboxId) return;
  let sandbox = open;
  if (!sandbox) {
    try {
      sandbox = await sliceRuntime().attach(state.sandboxId);
    } catch (error) {
      if (error instanceof SandboxGone) return;
      throw error;
    }
  }
  const usage = await readSandboxUsage(sandbox, { scanId });
  if (usage) await recordSandboxCost(scanId, sandbox.id, usage, state.huntAttempt ?? 0);
  await sandbox.destroy();
}

/** One `sandbox` ledger row per sandbox (its key comes from the sandbox's id), and the scan's compute cost as the sum of them. */
async function recordSandboxCost(scanId: string, sandboxId: string, usage: { seconds: number; usd: number }, attempt: number): Promise<void> {
  const row = { kind: "sandbox" as const, stage: "sandbox", role: null, seconds: usage.seconds, costUsd: usage.usd, costSource: "sandbox" as const, step: "hunt", attempt, key: sandboxKey(sandboxId) };
  for (let tries = 1; ; tries++) {
    try {
      await insertUsage(db(), scanId, [row]);
      break;
    } catch (error) {
      if (tries < 3) continue;
      console.error(`Sandbox cost for scan ${scanId} not written: ${describeError(error)}`);
      await captureException(Object.assign(new Error("Usage ledger rows were not written"), { name: "UsageLedgerUnwritten" }), { source: "billing", tags: { scan_id: scanId, rows: 1 }, handled: true });
      return;
    }
  }
  try {
    const totals = await scanUsageTotals(db(), scanId);
    await setComputeCost(db(), scanId, totals.filter((t) => t.kind === "sandbox").reduce((sum, t) => sum + Number(t.costUsd), 0));
  } catch (error) {
    console.error(`Compute cost for scan ${scanId} failed: ${describeError(error)}`);
  }
}

/** A UUID derived from the sandbox id, so recording one sandbox twice stores one row. */
export function sandboxKey(sandboxId: string): string {
  const h = createHash("sha256").update(`sandbox:${sandboxId}`).digest("hex");
  const variant = ((Number.parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The indexer's token lives only in the step that started it, and is stored nowhere. A later step stops
 * that indexer (freeing its port) and starts a fresh one with a new token.
 */
async function restartIndexer(sandbox: SliceSandbox, binary: IndexerBinary): Promise<IndexerHandle> {
  const stop = await sandbox.exec(["sh", "-c", STOP_INDEXER], { timeoutMs: 30_000 });
  if (stop.exitCode !== 0) throw new Error("The earlier indexer did not stop");
  return sandbox.startIndexer(binary);
}

/** Stops the sandbox user's own indexer, then waits until it is gone. */
export const STOP_INDEXER = `u="$(id -u)"
pkill -u "$u" -x sandchest-index || true
for i in $(seq 1 50); do pgrep -u "$u" -x sandchest-index >/dev/null || exit 0; sleep 0.2; done
pkill -KILL -u "$u" -x sandchest-index || true
sleep 1
! pgrep -u "$u" -x sandchest-index >/dev/null`;

/** When the session's CLI ended: the exit marker's modification time, else now. */
async function sessionEndedAt(sandbox: SliceSandbox, startedAt: number): Promise<Date> {
  try {
    const result = await sandbox.exec(["stat", "-c", "%Y", `${sandbox.agentDir}/${slice.SESSION_FILES.exit}`], { timeoutMs: 30_000 });
    const seconds = Number(result.stdout.trim());
    const at = seconds * 1000;
    // Whole seconds: the start may fall inside the same second.
    if (result.exitCode === 0 && Number.isInteger(seconds) && at >= startedAt - 1000 && at <= Date.now() + 60_000) return new Date(Math.max(at, startedAt));
  } catch {
    // The clock below.
  }
  return new Date();
}

/**
 * The checkout's files for the hunt. Listing them also reads, in bulk, every file the selection step can
 * read: those `isServerFile` could accept by path, the ones whose head it inspects included. Any other
 * file (a sibling read for deviance, say) is read on its own when asked for, as is everything when the
 * bulk read fails.
 */
function checkoutFiles(sandbox: SliceSandbox): { list: () => Promise<string[]>; read: (file: string) => Promise<string | undefined> } {
  const cache = new Map<string, Promise<string | undefined>>();
  let listed: Promise<string[]> | undefined;
  return {
    list: () =>
      (listed ??= (async () => {
        const result = await sandbox.exec(["git", "ls-files", "-z"], { timeoutMs: 120_000 });
        if (result.exitCode !== 0) throw new Error("Could not list the checkout's files");
        const files = result.stdout.split("\0").filter(Boolean);
        try {
          const read = await bulkReadFiles(sandbox, files.filter((file) => slice.isServerFile(file, "use server")));
          for (const [file, text] of read.files) cache.set(file, Promise.resolve(text));
        } catch (error) {
          console.error(`Bulk read of the checkout failed, reading files one by one: ${describeError(error)}`);
        }
        return files;
      })()),
    read: (file) => {
      let text = cache.get(file);
      if (!text) cache.set(file, (text = sandbox.readFile(file).catch(() => undefined)));
      return text;
    },
  };
}

async function readHunt(sandbox: SliceSandbox): Promise<{ findings: slice.FindingsEntry[]; candidates: slice.Candidate[] }> {
  const hunt = parseJson<{ findings: slice.FindingsEntry[]; candidates: slice.Candidate[] }>(await sandbox.readPrivateFile(FILES.hunt));
  if (!hunt) throw new Error("The hunt's result is missing from the sandbox");
  return hunt;
}

function parseJson<T>(text: string | undefined): T | undefined {
  return text === undefined ? undefined : (JSON.parse(text) as T);
}

function requireSandboxId(state: SliceState): string {
  if (!state.sandboxId) throw new Error("The scan has no sandbox");
  return state.sandboxId;
}

export function sliceState(scan: { stats: unknown }): SliceState {
  const stats = scan.stats as { slice?: SliceState } | null;
  return stats?.slice ?? {};
}

/** A pull request's review, as the classic path stores it. */
type PrReview = NonNullable<ScanReport["review"]>;

/** Merges into the top level of `stats`. */
async function saveStats(scanId: string, patch: Record<string, unknown>): Promise<void> {
  const scan = await scanById(db(), scanId);
  await updateScan(db(), scanId, { stats: { ...((scan?.stats ?? {}) as Record<string, unknown>), ...patch } });
}

/** Merges into `stats.slice` (or replaces it), keeping the rest of `stats`. One step writes at a time. */
async function saveSlice(scanId: string, patch: SliceState, options: { replace?: boolean } = {}): Promise<void> {
  const scan = await scanById(db(), scanId);
  const stats = (scan?.stats ?? {}) as Record<string, unknown>;
  const current = options.replace ? {} : sliceState({ stats });
  await updateScan(db(), scanId, { stats: { ...stats, slice: { ...current, ...patch } } });
}

/** Feed lines as the classic engine writes them: stage names the scan page knows, and a finding by its title only. */
function writeEvent(events: EventWriter, event: ScanEvent): void {
  events.write(event.type === "stage" ? `stage:${event.stage}` : event.type, event.type === "finding" ? `Found: ${event.finding.title}` : event.message);
}

function summary(findings: Finding[]): string {
  if (findings.length === 0) return "Nothing buried here. For now.";
  const counts = (["critical", "high", "medium", "low"] as const)
    .map((severity) => [severity, findings.filter((f) => f.severity === severity).length] as const)
    .filter(([, n]) => n > 0)
    .map(([severity, n]) => `${n} ${severity}`);
  return `Found ${findings.length} ${findings.length === 1 ? "finding" : "findings"}: ${counts.join(", ")}.`;
}

/**
 * Stage timings for `scan_stages`, best effort: writes go one after another in the background, a failed
 * one is logged by its error's name, and `flush` waits a few seconds at most. Never fails a scan.
 */
class StageRecorder {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly scanId: string) {}

  start(stage: string, attempt: number, at = new Date()): void {
    this.queue(() => startStage(db(), this.scanId, { stage, attempt, at }));
  }

  end(stage: string, attempt: number, outcome: StageOutcome, at = new Date()): void {
    this.queue(() => endStage(db(), this.scanId, { stage, attempt, at, outcome }));
  }

  record(stage: string, attempt: number, startedAt: Date, endedAt: Date, outcome: StageOutcome): void {
    this.queue(() => recordStage(db(), this.scanId, { stage, attempt, startedAt, endedAt, outcome }));
  }

  async flush(timeoutMs = 5_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)));
    try {
      await Promise.race([this.chain, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private queue(write: () => Promise<unknown>): void {
    this.chain = this.chain.then(write).then(
      () => undefined,
      (error: unknown) => console.error(`Stage timing for scan ${this.scanId} not written: ${error instanceof Error ? error.name : "error"}`),
    );
  }
}

