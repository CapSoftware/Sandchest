import { randomUUID } from "node:crypto";
import { claimWorkflowStart, releaseWorkflowStart, updateScan } from "@sandchest/db";
import { start } from "workflow/api";
import { scanWorkflow } from "@/workflows/scan";
import { db } from "./services";

/**
 * Starts a scan's workflow exactly once, however many deliveries race for
 * it: the start is reserved in the database first, and released if it fails.
 */
export async function startScan(scanId: string): Promise<void> {
  const claim = `starting:${randomUUID()}`;
  if (!(await claimWorkflowStart(db(), scanId, claim))) return;
  try {
    const run = await start(scanWorkflow, [scanId]);
    await updateScan(db(), scanId, { workflowRunId: run.runId });
  } catch (error) {
    await releaseWorkflowStart(db(), scanId, claim);
    throw error;
  }
}
