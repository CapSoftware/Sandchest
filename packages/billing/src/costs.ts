/**
 * The one credit table (SPEC §12). Tuned from measured per-scan costs; the
 * Autumn product config must agree with it. In credits of the unit the app
 * runs in (`units.ts`).
 */
import { catalog, CREDIT_UNIT } from "./units";

/** PR reviews are charged by security-relevant changed lines: most cost $1 (1 credit, or 100 in the cent unit). Over 5,000 lines the review is capped. */
export const PR_REVIEW_TIERS: ReadonlyArray<{ maxLines: number; credits: number }> = catalog(CREDIT_UNIT).prReviewTiers;

/** Lines a PR review covers before it narrows to the most security-relevant files. */
export const PR_REVIEW_LINE_CAP = 5_000;

/** Deep scans are charged by repository size (hand-written lines of code). */
export const DEEP_SCAN_TIERS: ReadonlyArray<{ maxLoc: number; credits: number }> = catalog(CREDIT_UNIT).deepScanTiers;

export function prReviewCredits(changedLines: number): number {
  return PR_REVIEW_TIERS.find((tier) => changedLines <= tier.maxLines)!.credits;
}

/** Credits for a deep scan, or `undefined` when the repository is too large to scan. */
export function deepScanCredits(loc: number): number | undefined {
  return DEEP_SCAN_TIERS.find((tier) => loc < tier.maxLoc)?.credits;
}

/** Recon and fix checks are free. */
export const FREE_SCANS = ["recon", "fix_check"] as const;

