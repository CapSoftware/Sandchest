/** What the Dig button can do for a repo. Pure, so pages can use it without loading the scan machinery. */
import { deepScanCredits } from "@sandchest/billing";

export type DigState = { state: "ready"; credits: number | undefined } | { state: "running"; scanId: string } | { state: "too_large" };

/**
 * A repo can be deep scanned again whenever nothing is running: each scan is
 * paid for with the org's own credits, so there is no wait between them.
 */
export function digState(repo: { loc: number | null; activeDeepScanId: string | null }): DigState {
  if (repo.activeDeepScanId) return { state: "running", scanId: repo.activeDeepScanId };
  if (repo.loc === null) return { state: "ready", credits: undefined };
  const credits = deepScanCredits(repo.loc);
  return credits === undefined ? { state: "too_large" } : { state: "ready", credits };
}
