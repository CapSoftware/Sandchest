/** Manual deep scans ("Dig"): one at a time per repo, then a 24-hour cooldown (SPEC §4). */
import { randomUUID } from "node:crypto";
import { DEEP_SCAN_TIERS } from "@sandchest/billing";
import { activeDeepScan, createScan, type Org, type Repo } from "@sandchest/db";
import { digState } from "@/lib/dig-state";
import { autumn, billingEnabled, reserveScan } from "./billing";
import { db, githubApp } from "./services";
import { startScan } from "./start";

export type DigResult =
  | { ok: true; scanId: string }
  | { ok: false; reason: "not_installed" | "running" | "cooling" | "too_large" | "no_plan" | "out_of_credits"; scanId?: string; retryAt?: Date; credits?: number };

/**
 * Starts a deep scan of a repo the caller is allowed to scan. Its credits are
 * held before the scan exists, so a refusal leaves nothing behind and the
 * person hears about it at once.
 */
export async function requestDeepScan(repo: Repo & { org: Org }, trigger: "manual" = "manual"): Promise<DigResult> {
  if (!repo.enabled || !repo.org.installationId) return { ok: false, reason: "not_installed" };
  const active = await activeDeepScan(db(), repo.id);
  const state = digState({ loc: repo.loc, lastDeepScanAt: repo.lastDeepScanAt, activeDeepScanId: active?.id ?? null });
  if (state.state === "running") return { ok: false, reason: "running", scanId: state.scanId };
  if (state.state === "cooling") return { ok: false, reason: "cooling", retryAt: state.retryAt };
  if (state.state === "too_large") return { ok: false, reason: "too_large" };

  // A repo whose size is not known yet (no recon) costs the smallest tier: never more than was shown.
  const credits = state.credits ?? DEEP_SCAN_TIERS[0]!.credits;
  const scanId = randomUUID();
  const gate = await reserveScan(scanId, { id: repo.org.id, githubLogin: repo.org.githubLogin }, credits, false);
  if (!gate.ok) return { ok: false, reason: gate.reason, credits };

  let created = false;
  try {
    const headSha = await githubApp().installation(repo.org.installationId).branchSha(repo.fullName, repo.defaultBranch);
    const billing = billingEnabled() ? { billing: "reserved" as const, creditsReserved: credits } : {};
    const { scan, created: isNew } = await createScan(db(), { id: scanId, ...billing, repoId: repo.id, orgId: repo.orgId, kind: "deep", trigger, headSha });
    if (!isNew) {
      // Another Dig won the race: give back what this one held and point at the scan that is running.
      await autumn()?.finalize({ customerId: repo.org.id, lockId: scanId, action: "release" }).catch(() => {});
      return { ok: false, reason: "running", scanId: scan.id };
    }
    created = true;
    // If this start fails, the stranded-scan sweep starts it within minutes: the credits stay held for it.
    await startScan(scan.id).catch((error: unknown) => console.error(`Starting deep scan ${scan.id} failed: ${error instanceof Error ? error.message : "error"}`));
    return { ok: true, scanId: scan.id };
  } catch (error) {
    if (!created) await autumn()?.finalize({ customerId: repo.org.id, lockId: scanId, action: "release" }).catch(() => {});
    throw error;
  }
}
