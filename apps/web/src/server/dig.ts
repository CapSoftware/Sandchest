/** Manual deep scans ("Dig"): one at a time per repo, then a 24-hour cooldown (SPEC §4). */
import { DEEP_SCAN_COOLDOWN_HOURS, deepScanCredits } from "@sandchest/billing";
import { activeDeepScan, createScan, type Org, type Repo } from "@sandchest/db";
import { db, githubApp } from "./services";
import { startScan } from "./start";

export type DigState =
  | { state: "ready"; credits: number | undefined }
  | { state: "running"; scanId: string }
  | { state: "cooling"; retryAt: Date }
  | { state: "too_large" };

/** What the Dig button can do for a repo right now. Pure: no database. */
export function digState(repo: { loc: number | null; lastDeepScanAt: Date | null; activeDeepScanId: string | null }, now = new Date()): DigState {
  if (repo.activeDeepScanId) return { state: "running", scanId: repo.activeDeepScanId };
  if (repo.lastDeepScanAt) {
    const retryAt = new Date(repo.lastDeepScanAt.getTime() + DEEP_SCAN_COOLDOWN_HOURS * 3_600_000);
    if (retryAt > now) return { state: "cooling", retryAt };
  }
  if (repo.loc === null) return { state: "ready", credits: undefined };
  const credits = deepScanCredits(repo.loc);
  return credits === undefined ? { state: "too_large" } : { state: "ready", credits };
}

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
