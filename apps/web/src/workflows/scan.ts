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

/** How long a scan waits for an org concurrency slot before giving up. */
const MAX_QUEUE_POLLS = 720; // × 10 s = 2 hours

export async function scanWorkflow(scanId: string): Promise<{ state: string }> {
  "use workflow";

  try {
    let { state, engine } = await beginStep(scanId);
    for (let polls = 0; state === "queued"; polls++) {
      if (polls >= MAX_QUEUE_POLLS) {
        await failStep(scanId, "Waited too long for a free scan slot.");
        return { state: "failed" };
      }
      await sleep("10s");
      ({ state, engine } = await beginStep(scanId));
    }
    if (state === "done") return { state };
    // Only a begin result that says so runs the slice engine; any other (one recorded by older code included) runs as before.
    if (engine === "slice") {
      await sliceSteps(scanId);
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

/** Polls of a sandbox session, 20 s apart: 40 minutes, after which it is stopped and what it wrote is collected. */
const SESSION_POLLS = 120;

/** Hunt, verify, variants, write-up, publish. On a failure the sandbox is cleaned up, then the error goes on to the fail step. */
async function sliceSteps(scanId: string): Promise<void> {
  try {
    // A pull request has no variants session. A hunt result recorded by older code has no `variants`: a deep scan's.
    const { selected, variants } = await sliceHuntStep(scanId);
    if (selected > 0 && (await sliceSession(scanId, "verify")) > 0 && variants !== false) await sliceSession(scanId, "variants");
    await sliceWriteUpStep(scanId);
    await slicePublishStep(scanId);
  } catch (error) {
    await sliceCleanupStep(scanId);
    throw error;
  }
}

/** Starts a session, polls it until it ends or runs out of time, then collects it. Returns how many verdicts were real. */
async function sliceSession(scanId: string, kind: SessionKind): Promise<number> {
  if (!(await sliceStartStep(scanId, kind)).started) return 0;
  let state = "running";
  for (let polls = 0; state === "running" && polls < SESSION_POLLS; polls++) {
    await sleep("20s");
    ({ state } = await sliceStatusStep(scanId, kind));
  }
  // A variants session that failed is collected for what it wrote; a verification that failed fails the scan.
  if (state === "failed" && kind === "verify") throw new Error("The verification in the sandbox stopped before it finished. Nothing was charged.");
  return (await sliceCollectStep(scanId, kind, state === "running")).real;
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
