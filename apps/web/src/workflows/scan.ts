/**
 * One workflow per scan, in coarse steps (SPEC §10): the whole scan fits in
 * one step under the function time limit, so conversations — which contain
 * code — never enter workflow storage. Steps take and return ids only.
 * A deep scan or PR review on the slice engine outlives one step, so it runs as several
 * (see `@/server/slice-scan`), each taking and returning ids and counts only.
 */
import { FatalError, getStepMetadata, sleep } from "workflow";
import { beginScan as begin, executeScan as execute, failScan as fail, publishScan as publish, ScanFinished } from "@/server/scans";
import { captureException } from "@/server/sentry";
import { cleanUpSlice, collectSliceSession, huntSlice, publishSlice, sliceSessionStatus, startSliceSession, writeUpSlice, type SessionKind } from "@/server/slice-scan";
import { billSlice } from "@/server/usage-billing";

/** How long a scan waits for an org concurrency slot before giving up. */
const MAX_QUEUE_POLLS = 720; // × 10 s = 2 hours

export async function scanWorkflow(scanId: string): Promise<{ state: string }> {
  "use workflow";

  try {
    let { state, engine, pricing } = await beginStep(scanId);
    for (let polls = 0; state === "queued"; polls++) {
      if (polls >= MAX_QUEUE_POLLS) {
        await failStep(scanId, "Waited too long for a free scan slot.");
        return { state: "failed" };
      }
      await sleep("10s");
      ({ state, engine, pricing } = await beginStep(scanId));
    }
    if (state === "done") return { state };
    // Only a begin result that says so runs the slice engine; any other (one recorded by older code included) runs as before.
    if (engine === "slice") {
      await sliceSteps(scanId, pricing);
      return { state: "completed" };
    }

    await executeStep(scanId);
    await publishStep(scanId);
    return { state: "completed" };
  } catch (error) {
    await failStep(scanId, error instanceof Error ? error.message : String(error));
    return { state: "failed" };
  }
}

async function beginStep(scanId: string) {
  "use step";
  return finishing("begin", scanId, () => begin(scanId));
}

async function executeStep(scanId: string) {
  "use step";
  // The run's number goes on its usage rows, so a bill can tell a run from the one before it.
  return finishing("execute", scanId, () => execute(scanId, { attempt: getStepMetadata().attempt }));
}
// A scan that fails twice is unlikely to pass a third time, and each attempt costs a scan's worth of model calls.
executeStep.maxRetries = 1;

async function publishStep(scanId: string) {
  "use step";
  return finishing("publish", scanId, () => publish(scanId));
}
publishStep.maxRetries = 5;

// ---- The slice engine (deep scans and PR reviews) -----------------------------

/** Polls of the sandbox sessions under way, 20 s apart: 40 minutes, after which they are stopped and what they wrote is collected. */
const SESSION_POLLS = 120;

/**
 * Hunt, verify, variants, write-up, the bill (only for a scan whose begin result says it is billed from its
 * usage, or in shadow), publish. On a failure the sandbox is cleaned up, then the error goes on to the fail step.
 */
async function sliceSteps(scanId: string, pricing?: "usage" | "shadow"): Promise<void> {
  try {
    // A pull request has no variants session. A hunt result recorded by older code has no `variants` (a deep
    // scan's) and no `secondBand` (one verification session, as that code ran).
    const { selected, variants, secondBand } = await sliceHuntStep(scanId);
    const confirmed = selected > 0 ? await sliceSessions(scanId, secondBand === true ? ["verify", "verify2"] : ["verify"]) : 0;
    if (confirmed > 0 && variants !== false) await sliceSessions(scanId, ["variants"]);
    await sliceWriteUpStep(scanId);
    if (pricing === "usage" || pricing === "shadow") await sliceBill(scanId);
    await slicePublishStep(scanId);
  } catch (error) {
    await sliceCleanupStep(scanId);
    throw error;
  }
}

/**
 * Starts the sessions one after another, so they run at the same time, polls them until every one has ended
 * or the time runs out, then collects them in the order given. Returns how many verdicts were real across them.
 *
 * The first verification session decides: nothing else starts when it does not, and the scan fails as soon as
 * it does. Any other session that fails or runs out of time is collected for what it wrote.
 */
async function sliceSessions(scanId: string, kinds: SessionKind[]): Promise<number> {
  const states = new Map<SessionKind, string>();
  for (const kind of kinds) {
    if ((await sliceStartStep(scanId, kind)).started) states.set(kind, "running");
    else if (kind === "verify") return 0;
  }
  const running = () => [...states].filter(([, state]) => state === "running").map(([kind]) => kind);
  const failed = () => states.get("verify") === "failed";
  for (let polls = 0; running().length > 0 && !failed() && polls < SESSION_POLLS; polls++) {
    await sleep("20s");
    for (const kind of running()) if (!failed()) states.set(kind, (await sliceStatusStep(scanId, kind)).state);
  }
  if (failed()) throw new Error("The verification in the sandbox stopped before it finished. Nothing was charged.");
  let real = 0;
  for (const [kind, state] of states) real += (await sliceCollectStep(scanId, kind, state === "running")).real;
  return real;
}

async function sliceHuntStep(scanId: string) {
  "use step";
  return finishing("slice_hunt", scanId, () => huntSlice(scanId, { attempt: getStepMetadata().attempt }));
}
// As `executeStep`: each attempt costs a hunt's worth of model calls.
sliceHuntStep.maxRetries = 1;

async function sliceStartStep(scanId: string, kind: SessionKind) {
  "use step";
  return finishing("slice_start", scanId, () => startSliceSession(scanId, kind));
}
sliceStartStep.maxRetries = 2;

async function sliceStatusStep(scanId: string, kind: SessionKind) {
  "use step";
  return finishing("slice_status", scanId, () => sliceSessionStatus(scanId, kind));
}

async function sliceCollectStep(scanId: string, kind: SessionKind, timedOut: boolean) {
  "use step";
  return finishing("slice_collect", scanId, () => collectSliceSession(scanId, kind, { timedOut }));
}

async function sliceWriteUpStep(scanId: string) {
  "use step";
  return finishing("slice_writeup", scanId, () => writeUpSlice(scanId, { attempt: getStepMetadata().attempt }));
}
sliceWriteUpStep.maxRetries = 1;

/** Polls of the bill step, 30 s apart, while a model call may still be under way; the last one bills the ledger as it is. */
const BILL_POLLS = 40;

async function sliceBill(scanId: string): Promise<void> {
  for (let polls = 0; (await sliceBillStep(scanId, polls >= BILL_POLLS)).state === "waiting"; polls++) await sleep("30s");
}

async function sliceBillStep(scanId: string, final: boolean) {
  "use step";
  return finishing("slice_bill", scanId, () => billSlice(scanId, { final }));
}
sliceBillStep.maxRetries = 5;

async function slicePublishStep(scanId: string) {
  "use step";
  return finishing("publish", scanId, () => publishSlice(scanId));
}
slicePublishStep.maxRetries = 5;

async function sliceCleanupStep(scanId: string) {
  "use step";
  return cleanUpSlice(scanId);
}
sliceCleanupStep.maxRetries = 5;

async function failStep(scanId: string, message: string) {
  "use step";
  return finishing("fail", scanId, () => fail(scanId, message));
}
failStep.maxRetries = 5;

/**
 * Expected endings are not retried. Anything else is reported (when Sentry is
 * set up) with the step's name and the scan's opaque id, then retried.
 */
async function finishing<T>(step: string, scanId: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof ScanFinished) throw new FatalError(error.message);
    await captureException(error, { source: "workflow", tags: { step, scan_id: scanId } });
    throw error;
  }
}
