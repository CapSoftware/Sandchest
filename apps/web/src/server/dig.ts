/** Manual deep scans ("Dig"): one at a time per repo, then a 24-hour cooldown (SPEC §4). */
import { randomUUID } from "node:crypto";
import { DEEP_SCAN_TIERS } from "@sandchest/billing";
import { activeDeepScan, createScan, deleteUnstartedScan, type Org, type Repo } from "@sandchest/db";
import { digState } from "@/lib/dig-state";
import { autumn, reserveScan } from "./billing";
import { describeError } from "./log";
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
  const headSha = await githubApp().installation(repo.org.installationId).branchSha(repo.fullName, repo.defaultBranch);

  // Claim the repo's one deep-scan slot before holding any credits, so a second
  // Dig that loses the race never reaches Autumn: no hold, no auto top-up, no
  // low-credit email from a scan that never runs.
  const { scan, created } = await createScan(db(), { id: randomUUID(), repoId: repo.id, orgId: repo.orgId, kind: "deep", trigger, headSha });
  if (!created) return { ok: false, reason: "running", scanId: scan.id };

  let gate: Awaited<ReturnType<typeof reserveScan>>;
  try {
    gate = await reserveScan(scan.id, { id: repo.org.id, githubLogin: repo.org.githubLogin }, credits);
  } catch (error) {
    // Give back anything Autumn may hold, and the slot.
    await autumn()?.finalize({ customerId: repo.org.id, lockId: scan.id, action: "release" }).catch(() => {});
    await deleteUnstartedScan(db(), scan.id);
    throw error;
  }
  if (!gate.ok) {
    // Refused: the scan never started, so it leaves nothing behind.
    await deleteUnstartedScan(db(), scan.id);
    return { ok: false, reason: gate.reason, credits };
  }
  // If this start fails, the stranded-scan sweep starts it within minutes: the credits stay held for it.
  await startScan(scan.id).catch((error: unknown) => console.error(`Starting deep scan ${scan.id} failed: ${describeError(error)}`));
  return { ok: true, scanId: scan.id };
}
