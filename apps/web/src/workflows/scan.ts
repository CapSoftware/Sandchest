/**
 * One workflow per scan, in coarse steps (SPEC §10): the whole scan fits in
 * one step under the function time limit, so conversations — which contain
 * code — never enter workflow storage. Steps take and return ids only.
 */
import { FatalError, getStepMetadata, sleep } from "workflow";
import { beginScan as begin, executeScan as execute, failScan as fail, publishScan as publish, ScanFinished } from "@/server/scans";
import { captureException } from "@/server/sentry";

/** How long a scan waits for an org concurrency slot before giving up. */
const MAX_QUEUE_POLLS = 720; // × 10 s = 2 hours

export async function scanWorkflow(scanId: string): Promise<{ state: string }> {
  "use workflow";

  try {
    let { state } = await beginStep(scanId);
    for (let polls = 0; state === "queued"; polls++) {
      if (polls >= MAX_QUEUE_POLLS) {
        await failStep(scanId, "Waited too long for a free scan slot.");
        return { state: "failed" };
      }
      await sleep("10s");
      ({ state } = await beginStep(scanId));
    }
    if (state === "done") return { state };

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
