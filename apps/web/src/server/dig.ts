/** Manual deep scans ("Dig"): one at a time per repo, then a 24-hour cooldown (SPEC §4). */
import { activeDeepScan, createScan, type Org, type Repo } from "@sandchest/db";
import { digState } from "@/lib/dig-state";
import { db, githubApp } from "./services";
import { startScan } from "./start";

export type DigResult = { ok: true; scanId: string } | { ok: false; reason: "not_installed" | "running" | "cooling" | "too_large"; scanId?: string; retryAt?: Date };

/** Starts a deep scan of a repo the caller is allowed to scan. */
export async function requestDeepScan(repo: Repo & { org: Org }, trigger: "manual" = "manual"): Promise<DigResult> {
  if (!repo.enabled || !repo.org.installationId) return { ok: false, reason: "not_installed" };
  const active = await activeDeepScan(db(), repo.id);
  const state = digState({ loc: repo.loc, lastDeepScanAt: repo.lastDeepScanAt, activeDeepScanId: active?.id ?? null });
  if (state.state === "running") return { ok: false, reason: "running", scanId: state.scanId };
  if (state.state === "cooling") return { ok: false, reason: "cooling", retryAt: state.retryAt };
  if (state.state === "too_large") return { ok: false, reason: "too_large" };
  const headSha = await githubApp().installation(repo.org.installationId).branchSha(repo.fullName, repo.defaultBranch);
  const { scan } = await createScan(db(), { repoId: repo.id, orgId: repo.orgId, kind: "deep", trigger, headSha });
  await startScan(scan.id);
  return { ok: true, scanId: scan.id };
}
