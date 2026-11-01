/**
 * The one credit table (SPEC §12). Tuned from measured per-scan costs; the
 * Autumn product config must agree with it.
 */

/** PR reviews are charged by security-relevant changed lines. Over 5,000 lines the review is capped. */
export const PR_REVIEW_TIERS: ReadonlyArray<{ maxLines: number; credits: number }> = [
  { maxLines: 100, credits: 1 },
  { maxLines: 500, credits: 2 },
  { maxLines: 1_500, credits: 3 },
  { maxLines: 5_000, credits: 4 },
  { maxLines: Number.POSITIVE_INFINITY, credits: 5 },
];

/** Lines a PR review covers before it narrows to the most security-relevant files. */
export const PR_REVIEW_LINE_CAP = 5_000;

/** Deep scans are charged by repository size (hand-written lines of code). */
export const DEEP_SCAN_TIERS: ReadonlyArray<{ maxLoc: number; credits: number }> = [
  { maxLoc: 100_000, credits: 15 },
  { maxLoc: 300_000, credits: 30 },
  { maxLoc: 1_000_000, credits: 75 },
];

export function prReviewCredits(changedLines: number): number {
  return PR_REVIEW_TIERS.find((tier) => changedLines <= tier.maxLines)!.credits;
}

/** Credits for a deep scan, or `undefined` when the repository is too large to scan. */
export function deepScanCredits(loc: number): number | undefined {
  return DEEP_SCAN_TIERS.find((tier) => loc < tier.maxLoc)?.credits;
}

/** Recon and fix checks are free. */
export const FREE_SCANS = ["recon", "fix_check"] as const;

/** Hours between manual deep scans of one repository. */
export const DEEP_SCAN_COOLDOWN_HOURS = 24;
