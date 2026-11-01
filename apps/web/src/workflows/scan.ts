/**
 * One workflow per scan, in coarse steps (SPEC §10): the whole scan fits in
 * one step under the function time limit, so conversations — which contain
 * code — never enter workflow storage. Steps take and return ids only.
 */
import { FatalError, sleep } from "workflow";
import { beginScan as begin, executeScan as execute, failScan as fail, publishScan as publish, ScanFinished } from "@/server/scans";

/** How long a scan waits for an org concurrency slot before giving up. */
const MAX_QUEUE_POLLS = 360; // × 20 s = 2 hours

export async function scanWorkflow(scanId: string): Promise<{ state: string }> {
  "use workflow";

  try {
    let { state } = await beginStep(scanId);
    for (let polls = 0; state === "queued"; polls++) {
      if (polls >= MAX_QUEUE_POLLS) {
        await failStep(scanId, "Waited too long for a free scan slot.");
        return { state: "failed" };
      }
      await sleep("20s");
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
  return finishing(() => begin(scanId));
}

async function executeStep(scanId: string) {
  "use step";
  return finishing(() => execute(scanId));
}
// A scan that fails twice is unlikely to pass a third time, and each attempt costs a scan's worth of model calls.
executeStep.maxRetries = 1;

async function publishStep(scanId: string) {
  "use step";
  return finishing(() => publish(scanId));
}
publishStep.maxRetries = 5;

async function failStep(scanId: string, message: string) {
  "use step";
  return finishing(() => fail(scanId, message));
}
failStep.maxRetries = 5;

/** Expected endings are not retried. */
async function finishing<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof ScanFinished) throw new FatalError(error.message);
    throw error;
  }
}
