/**
 * A deep scan on the slice engine, in workflow steps that each fit a function's time limit: hunt (open a
 * sandbox, select code, hunt and score from this server), a verification session and a variants session
 * run by an agent inside the sandbox (started by one step, polled and collected by later ones), then the
 * write-up, persisted as a classic deep scan is.
 *
 * Steps take and return ids, enums and counts only. Between steps, the scan row's `stats.slice` holds ids
 * and numbers; the hunt result, the verdicts and the confirmed findings stay inside the sandbox, in a
 * directory only its own user can enter, so no code or finding text reaches workflow storage.
 */
import { createHash } from "node:crypto";
import { deepScanCredits } from "@sandchest/billing";
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
import { adoptKnownFingerprints, DEFAULT_LIMITS, ScanRefusedError, slice, UnpricedCallError, type Finding, type ScanEvent, type UsageSink } from "@sandchest/engine/scan";
import type { IndexerBinary, IndexerHandle } from "@sandchest/workspace";
import { agentSandboxSetupScript, bulkReadFiles } from "@sandchest/workspace/boat";
import { config } from "./config";
import { captureFromScan } from "./cves";
import { gatewayEndpoint, mintGatewayToken, STALE_CALL_SECONDS } from "./gateway";
import { describeError } from "./log";
import { noticeScanPaused } from "./notices";
import { indexerBinary, isEmptyRepoError, prepareWorkspace, publishScan, requireScan, ScanFinished, toFindingInput, type LoadedScan } from "./scans";
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
  sessions?: Partial<Record<SessionKind, SessionState>>;
  /** Findings written by the write-up; set once they are persisted. */
  findings?: number;
  written?: boolean;
}

/** The scan's spend reached SANDCHEST_SLICE_CEILING_USD. */
export class SpendCeilingReached extends Error {
  override readonly name = "SpendCeilingReached";
  constructor() {
    super("The scan reached its spending ceiling");
  }
}

const CEILING_MESSAGE = "The scan reached its spending ceiling, so it was stopped. Nothing was charged.";

// ---- Hunt ---------------------------------------------------------------------

/**
 * Opens the sandbox (clone, indexer, agent CLI), runs the slice hunt and keeps its result in the sandbox.
 * A run of this step that is retried first deletes the sandbox the earlier run left. Returns how many
 * candidates were selected for verification.
 */
export async function huntSlice(scanId: string, run: { attempt?: number; /** For tests. Default the engine's. */ passDelayMs?: number } = {}): Promise<{ selected: number }> {
  const scan = await requireScan(scanId);
  if (scan.status !== "running") return { selected: 0 };
  const installationId = scan.repo.org.installationId;
  if (!installationId || !scan.repo.enabled) throw new ScanFinished("Repository is no longer installed");
  const settings = config();
  const runtime = sliceRuntime();
  const installation = githubApp().installation(installationId);

  const attempt = Math.max(await nextUsageAttempt(db(), scan.id, "hunt"), run.attempt ?? 0);
  const stages = new StageRecorder(scan.id);
  if (scan.startedAt) stages.record("queue", 0, scan.createdAt, scan.startedAt, "ok");
  // A retry starts over: the earlier run's sandbox goes first, its cost recorded under that run.
  await releaseSandbox(scan.id, sliceState(scan));

  const events = new EventWriter(db(), scan.id);
  const ledger = new UsageLedger({ scanId: scan.id, write: (rows) => insertUsage(db(), scan.id, rows), step: "hunt", attempt });
  const guard = await spendGuard(scan.id, ledger);
  const started = Date.now();
  let inventory: ReturnType<typeof captureFromScan> | undefined;
  try {
    if (guard.signal.aborted) throw guard.signal.reason;
    stages.start("sandbox", attempt);
    events.write("stage:setup", "Starting a fresh sandbox and fetching the code…");
    const url = `${(settings.SANDCHEST_GIT_HOST ?? "https://github.com").replace(/\/$/, "")}/${scan.repo.fullName}.git`;
    let prepared: { sandbox: SliceSandbox; headSha: string; handle: IndexerHandle };
    try {
      let opened: SliceSandbox | undefined;
      const ready = await prepareWorkspace({
        open: async () => {
          opened = await runtime.open({ ttlSeconds: SLICE_TTL_SECONDS, setupScript: agentSandboxSetupScript({ allowHosts: [], loopbackPorts: [RELAY_PORT], dns: false }) });
          // Recorded before anything else, so a later step can always find it and delete it.
          try {
            await saveSlice(scan.id, { sandboxId: opened.id, huntAttempt: attempt }, { replace: true });
          } catch (error) {
            await opened.destroy().catch(() => {});
            throw error;
          }
          return opened;
        },
        clone: async (workspace) => workspace.clone({ url, ref: scan.headSha }, { depth: 1, token: await installation.cloneToken(scan.repo.githubRepoId), timeoutMs: CLONE_TIMEOUT_MS }),
        binary: indexerBinary(settings.workspace),
        started,
        onRetry: (message) => events.write("progress", message),
      });
      prepared = { sandbox: ready.workspace as SliceSandbox, headSha: ready.headSha, handle: ready.handle };
      await runtime.prepareAgentSandbox(prepared.sandbox);
      stages.end("sandbox", attempt, "ok");
    } catch (error) {
      stages.end("sandbox", attempt, "failed");
      throw error;
    }
    const { sandbox, headSha, handle } = prepared;
    const indexer = runtime.indexer(handle);

    // Lines of code as the classic engine measures them, for the charge and the size limit.
    events.write("stage:index", "Indexing the code and choosing what to hunt in…");
    const { loc } = await indexer.call<{ loc: number }>("overview", {});
    if (loc > DEFAULT_LIMITS.maxLoc) throw new ScanRefusedError(`This repository has ${loc.toLocaleString("en")} lines of code; the limit is ${DEFAULT_LIMITS.maxLoc.toLocaleString("en")}.`);
    // The CVE directory's inventory, read from the default branch while the hunt runs, as a classic deep scan does.
    inventory = captureFromScan(scan.repo.id, headSha, scan.headSha === "HEAD" ? new Date(started) : scan.createdAt, indexer);

    const files = checkoutFiles(sandbox);
    const result = await slice.runSliceHunt({
      client: sliceClient(),
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
    return { selected };
  } catch (error) {
    return await stopped(scan, error, guard.signal);
  } finally {
    await inventory?.read;
    await Promise.allSettled([events.flush(), inventory?.done, closeLedger(scan.id, ledger), stages.flush()]);
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
    const { ceilingMicroUsd, secret } = sliceLimits();
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
    const token = mintGatewayToken({ scanId: scan.id, stage: kind, attempt, ceilingMicroUsd, ttlSeconds: SESSION_TOKEN_TTL_SECONDS }, secret);
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
 * Writes up what the agent confirmed, persists it as a classic deep scan does, records the sandbox's cost
 * and deletes the sandbox. With nothing confirmed, the scan completes with no findings the same way.
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
  const guard = await spendGuard(scan.id, ledger);
  const started = Date.now();
  stages.start("writeup", attempt, new Date(started));
  try {
    if (guard.signal.aborted) throw guard.signal.reason;
    if (state.loc === undefined) throw new Error("The scan has no measured size");
    const runtime = sliceRuntime();
    const sandbox = await runtime.attach(requireSandboxId(state));
    const sessions = state.sessions ?? {};
    let findings: Finding[] = [];
    if ((sessions.verify?.real ?? 0) > 0) {
      const hunt = await readHunt(sandbox);
      const verdicts = parseJson<slice.Verdict[]>(await sandbox.readPrivateFile(FILES.verify)) ?? [];
      const variants = sessions.variants?.collected
        ? { verdicts: parseJson<slice.Verdict[]>(await sandbox.readPrivateFile(FILES.variants)) ?? [], confirmed: parseJson<slice.ConfirmedEntry[]>(await sandbox.readPrivateFile(FILES.confirmed)) ?? [] }
        : undefined;
      events.write("stage:verify", "Writing up what was confirmed…");
      const indexer = runtime.indexer(await restartIndexer(sandbox, indexerBinary(config().workspace)));
      const out = await slice.writeUpVerdicts({
        client: sliceClient(),
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

    // As `executeScan` persists a deep scan.
    const recognised = adoptKnownFingerprints(findings, await knownFindings(db(), scan.repo.id));
    const { ids, newIds } = await upsertFindings(db(), scan.repo.id, scan, recognised.map(toFindingInput));
    const credits = deepScanCredits(state.loc) ?? 0;
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
    await updateScan(db(), scan.id, { credits, stats: { findingIds: ids, newFindingIds: newIds, loc: state.loc, slice: written } });
    await markDeepScanned(db(), scan.repo.id, new Date(), state.loc);
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

function sliceLimits(): { ceilingMicroUsd: number; secret: string } {
  const settings = config();
  if (!settings.SANDCHEST_SLICE_CEILING_USD || !settings.SANDCHEST_GATEWAY_SECRET) throw new ScanFinished("The slice engine is no longer configured.");
  return { ceilingMicroUsd: usdToMicroUsd(settings.SANDCHEST_SLICE_CEILING_USD), secret: settings.SANDCHEST_GATEWAY_SECRET };
}

/**
 * The ledger's sink, adding each call's cost to what the scan had spent when the step began. At the
 * ceiling it aborts the returned signal, which the engine is given: no further call starts.
 */
async function spendGuard(scanId: string, ledger: UsageLedger): Promise<{ onUsage: UsageSink; signal: AbortSignal }> {
  const { ceilingMicroUsd } = sliceLimits();
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

