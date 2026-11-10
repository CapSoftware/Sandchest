/**
 * How pricing is put into words, from the cost table itself, so every page
 * that explains it says the same thing and stays right when it changes.
 */
import { DEEP_SCAN_TIERS, PR_REVIEW_TIERS } from "@sandchest/billing/costs";
import { CREDIT_PACK, CREDIT_PRICE, CREDIT_TIERS, PLAN } from "@sandchest/billing/plans";
import { creditCount, creditsText, usd } from "./format";

const and = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`);
const list = (items: number[]) => (items.length < 2 ? creditCount(items[0]!) : `${items.slice(0, -1).map(creditCount).join(", ")} or ${creditCount(items.at(-1)!)}`);

/** A price for credits as said: "$1 each", or "$1 per 100" where credits are sold by the 100. */
export function perCredit(price: number): string {
  return CREDIT_PACK === 1 ? `${usd(price)} each` : `${usd(price)} per ${creditCount(CREDIT_PACK)}`;
}

/** What a pull request review costs, smallest to largest: "1 to 3 credits". */
export const PR_REVIEW_RANGE = `${creditCount(PR_REVIEW_TIERS[0]!.credits)} to ${creditsText(PR_REVIEW_TIERS.at(-1)!.credits)}`;

/** The credits a pull request review costs after the smallest tier, e.g. [2, 3]. */
const largerReviews = PR_REVIEW_TIERS.slice(1).map((tier) => tier.credits);

/** The volume discounts after the base price, e.g. ["25 or more at once are $0.90 each", "50 or more $0.85", …]. */
const bulk = CREDIT_TIERS.slice(1).map((tier, i) => (i === 0 ? `${creditCount(tier.from)} or more at once are ${perCredit(tier.price)}` : `${creditCount(tier.from)} or more ${usd(tier.price)}`));

/** One sentence each: the plan, credit prices, what a review costs, what a deep scan costs, what is free. */
export const PRICES = {
  plan: `${usd(PLAN.price)} a month, and credits are ${perCredit(CREDIT_PRICE)}, less in bulk.`,
  credits: `Credits are ${perCredit(CREDIT_PRICE)}${bulk.length ? `; ${and(bulk)}` : ""}.`,
  review: `A pull request review is usually ${creditsText(PR_REVIEW_TIERS[0]!.credits)}; very large ones are ${list(largerReviews)}.`,
  dig: `A deep scan of a whole repository is ${list(DEEP_SCAN_TIERS.map((tier) => tier.credits))} credits, by its size.`,
  free: "Recon and fix checks are free while there are credits left.",
};

/** The whole price list as one paragraph. */
export const PRICE_NOTE = `${PRICES.review} ${PRICES.dig} ${PRICES.free}`;
