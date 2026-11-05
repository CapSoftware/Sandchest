/**
 * Reads one repository's dependency inventory for the CVE directory: one step,
 * no model, no credits. Takes and returns ids and counts only; no code or
 * package list enters workflow storage.
 */
import { refreshInventory } from "@/server/cves";
import { captureException } from "@/server/sentry";

export async function inventoryWorkflow(repoId: string): Promise<{ state: string }> {
  "use workflow";

  try {
    return await refreshStep(repoId);
  } catch {
    // The repository stays due (its request isn't cleared), so the sweep tries again.
    return { state: "failed" };
  }
}

async function refreshStep(repoId: string): Promise<{ state: string; dependencies?: number }> {
  "use step";
  try {
    return await refreshInventory(repoId);
  } catch (error) {
    await captureException(error, { source: "workflow", tags: { step: "inventory", repo_id: repoId } });
    throw error;
  }
}
refreshStep.maxRetries = 1;
