/**
 * What a scan billed from its usage is quoted before it starts: the most it can be charged, which is what it
 * holds. Decided here, on the server, from the account's pricing: the browser only ever sees whole credits.
 * Undefined for an account whose scans are priced by tier (or in shadow, which charges the tier price), so
 * every quote for it stays exactly as it was. Past the slice engine's daily limit, as this instance last read it
 * (`sliceAllowedCached`), scans are priced classic and nothing is quoted, unless they wait for it instead
 * (`slicePaused`): then they are still billed from their usage once they start, and quoted so.
 */
import { usageHold } from "./billing";
import { config, fastOffered, scanPricing, type Config } from "./config";
import { sliceAllowedCached, slicePaused } from "./slice-limit";

/** Whether quotes price slice now: under the limit, or past it with scans waiting rather than running classic. */
const quotedSlice = (settings: Config) => sliceAllowedCached(settings) || slicePaused(settings);

export interface UsageQuote {
  /** Credits a deep scan holds: the most it can be charged. */
  hold: number;
  /** The same for a fast deep scan, when the account is offered one. */
  fast?: number;
}

/** The usage quote for an account's deep scans, or undefined when they are not billed from usage. */
export function deepScanQuote(githubLogin: string, settings: Config = config()): UsageQuote | undefined {
  const pricing = scanPricing({ kind: "deep", fast: false }, githubLogin, settings, quotedSlice(settings));
  if (pricing.mode !== "usage") return undefined;
  const hold = usageHold(pricing);
  if (!fastOffered(githubLogin, settings)) return { hold };
  return { hold, fast: usageHold(scanPricing({ kind: "deep", fast: true }, githubLogin, settings)) };
}

/** The most a pull request review of the account can be charged, or undefined when reviews are not billed from usage. */
export function prReviewQuote(githubLogin: string, settings: Config = config()): number | undefined {
  const pricing = scanPricing({ kind: "pr_review", fast: false }, githubLogin, settings, quotedSlice(settings));
  return pricing.mode === "usage" ? usageHold(pricing) : undefined;
}

/** Quotes per account, each worked out once: for lists that show many repositories of a few accounts. */
export function quotesByAccount(): (githubLogin: string) => UsageQuote | undefined {
  const seen = new Map<string, UsageQuote | undefined>();
  return (githubLogin) => {
    if (!seen.has(githubLogin)) seen.set(githubLogin, deepScanQuote(githubLogin));
    return seen.get(githubLogin);
  };
}
