import { randomUUID } from "node:crypto";
import { claimWorkflowStart, releaseWorkflowStart, updateScan } from "@sandchest/db";
import { getRun, start } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/errors";
import { inventoryWorkflow } from "@/workflows/inventory";
import { scanWorkflow } from "@/workflows/scan";
import { db } from "./services";

let starter: ((scanId: string) => Promise<void>) | undefined;

/** For tests: start scans with this instead of the workflow runtime. */
export function setScanStarter(start: ((scanId: string) => Promise<void>) | undefined): void {
  starter = start;
}

/**
 * Starts a scan's workflow exactly once, however many deliveries race for
 * it: the start is reserved in the database first, and released if it fails.
 */
export async function startScan(scanId: string): Promise<void> {
  if (starter) return starter(scanId);
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

let inventoryStarter: ((repoId: string) => Promise<void>) | undefined;

/** For tests: start inventory refreshes with this instead of the workflow runtime. */
export function setInventoryStarter(start: ((repoId: string) => Promise<void>) | undefined): void {
  inventoryStarter = start;
}

/**
 * Starts a repository's inventory refresh (see `refreshInventory`). Duplicate
 * starts are harmless: the refresh claims the repository first, and a second
 * one finds it taken and ends.
 */
export async function startInventory(repoId: string): Promise<void> {
  if (inventoryStarter) return inventoryStarter(repoId);
  await start(inventoryWorkflow, [repoId]);
}

let runStatus: ((runId: string) => Promise<string | undefined>) | undefined;

/** For tests: report workflow run statuses with this instead of the workflow runtime. */
export function setRunStatus(status: ((runId: string) => Promise<string | undefined>) | undefined): void {
  runStatus = status;
}

/**
 * Whether a scan's workflow may still be running: true unless the runtime
 * says its run has ended or does not exist. A start that never recorded its
 * run can't be asked about, so it counts as running.
 */
export async function workflowRunning(runId: string | null): Promise<boolean> {
  if (!runId) return false;
  if (runId.startsWith("starting:")) return true;
  const status = runStatus
    ? await runStatus(runId)
    : await getRun(runId).status.catch((error: unknown) => {
        if (WorkflowRunNotFoundError.is(error)) return undefined;
        throw error;
      });
  return status === "pending" || status === "running";
}
