import { updateScan } from "@sandchest/db";
import { start } from "workflow/api";
import { scanWorkflow } from "@/workflows/scan";
import { db } from "./services";

/** Starts a scan's workflow and records its run id. */
export async function startScan(scanId: string): Promise<void> {
  const run = await start(scanWorkflow, [scanId]);
  await updateScan(db(), scanId, { workflowRunId: run.runId });
}
