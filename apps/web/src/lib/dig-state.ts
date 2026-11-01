/** What the Dig button can do for a repo. Pure, so pages can use it without loading the scan machinery. */
import { DEEP_SCAN_COOLDOWN_HOURS, deepScanCredits } from "@sandchest/billing";

export type DigState =
  | { state: "ready"; credits: number | undefined }
  | { state: "running"; scanId: string }
  | { state: "cooling"; retryAt: Date }
  | { state: "too_large" };

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

