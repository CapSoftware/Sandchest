/** Manual deep scans ("Dig"): one at a time per repo, as often as the org's credits allow (SPEC §4). */
import { randomUUID } from "node:crypto";
import { DEEP_SCAN_TIERS } from "@sandchest/billing";
import { activeDeepScan, createScan, deleteUnstartedScan, type Org, type Repo } from "@sandchest/db";
import { digState } from "@/lib/dig-state";
import { autumn, billingFrozen, heldCredits, reserveScan } from "./billing";
import { config, fastOffered, scanPricing } from "./config";
import { describeError } from "./log";
import { db, githubApp } from "./services";
import { sliceAllowedNow } from "./slice-limit";
import { startScan } from "./start";

export type DigResult =
  | { ok: true; scanId: string; heldUpTo?: number }
  | { ok: false; reason: "not_installed" | "running" | "too_large" | "no_plan" | "out_of_credits" | "fast_unavailable" | "frozen"; scanId?: string; credits?: number };

/**
 * Starts a deep scan of a repo the caller is allowed to scan. Its credits are
 * held before the scan exists, so a refusal leaves nothing behind and the
 * person hears about it at once. `headSha`: the default branch's commit when
 * the caller has just read it. `fast`: a person chose a fast scan, which is refused unless the account is offered
 * one (`fastOffered`); a scheduled scan is never fast. `heldUpTo` is set for a scan billed from its usage: the
 * credits it holds, the most it can be charged. While billing is frozen it is refused (`frozen`): it would hold credits.
 */
export async function requestDeepScan(repo: Repo & { org: Org }, trigger: "manual" | "schedule" = "manual", options: { headSha?: string; fast?: boolean } = {}): Promise<DigResult> {
  if (options.fast && (trigger !== "manual" || !fastOffered(repo.org.githubLogin))) return { ok: false, reason: "fast_unavailable" };
  if (!repo.enabled || !repo.org.installationId) return { ok: false, reason: "not_installed" };
  const active = await activeDeepScan(db(), repo.id);
  const state = digState({ loc: repo.loc, activeDeepScanId: active?.id ?? null });
  if (state.state === "running") return { ok: false, reason: "running", scanId: state.scanId };
  if (state.state === "too_large") return { ok: false, reason: "too_large" };
  if (billingFrozen()) return { ok: false, reason: "frozen" };

  const headSha = options.headSha ?? (await githubApp().installation(repo.org.installationId).branchSha(repo.fullName, repo.defaultBranch));

  // Claim the repo's one deep-scan slot before holding any credits, so a second
  // Dig that loses the race never reaches Autumn: no hold, no auto top-up, no
  // low-credit email from a scan that never runs.
  const { scan, created } = await createScan(db(), { id: randomUUID(), repoId: repo.id, orgId: repo.orgId, kind: "deep", trigger, headSha, ...(options.fast && { fast: true }) });
  if (!created) return { ok: false, reason: "running", scanId: scan.id };

  let gate: Awaited<ReturnType<typeof reserveScan>>;
  let credits = 0;
  let usage = false;
  try {
    // A repo recon has not sized yet holds the most a deep scan can cost, and is charged what the scan
    // measures (never more than it held). Inside the try: a failure here cleans up like any other, and never
    // leaves a scan to be charged later.
    // How the scan is priced is decided here, with its hold, and stored with it.
    const pricing = scanPricing(scan, repo.org.githubLogin, config(), await sliceAllowedNow(scan.kind, repo.org.githubLogin));
    credits = heldCredits(pricing, state.credits ?? DEEP_SCAN_TIERS.at(-1)!.credits);
    usage = pricing.mode === "usage";
    gate = await reserveScan(scan.id, { id: repo.org.id, githubLogin: repo.org.githubLogin }, credits, true, { pricing });
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
  return { ok: true, scanId: scan.id, ...(usage && { heldUpTo: credits }) };
}
