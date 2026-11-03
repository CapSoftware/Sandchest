/**
 * How pricing is put into words, from the cost table itself, so every page
 * that explains it says the same thing and stays right when it changes.
 */
import { DEEP_SCAN_TIERS, PR_REVIEW_TIERS } from "@sandchest/billing/costs";
import { CREDIT_PRICE, CREDIT_TIERS, PLAN } from "@sandchest/billing/plans";
import { usd } from "./format";

const and = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`);
const list = (items: number[]) => (items.length < 2 ? String(items[0]) : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

/** The credits a pull request review costs after the smallest tier, e.g. [2, 3]. */
const largerReviews = PR_REVIEW_TIERS.slice(1).map((tier) => tier.credits);

/** The volume discounts after the base price, e.g. ["25 or more at once are $0.90 each", "50 or more $0.85", …]. */
const bulk = CREDIT_TIERS.slice(1).map((tier, i) => (i === 0 ? `${tier.from} or more at once are ${usd(tier.price)} each` : `${tier.from} or more ${usd(tier.price)}`));

/** One sentence each: the plan, credit prices, what a review costs, what a deep scan costs, what is free. */
export const PRICES = {
  plan: `${usd(PLAN.price)} a month, and credits are ${usd(CREDIT_PRICE)} each, less in bulk.`,
  credits: `Credits are ${usd(CREDIT_PRICE)} each${bulk.length ? `; ${and(bulk)}` : ""}.`,
  review: `A pull request review is usually ${PR_REVIEW_TIERS[0]!.credits} credit; very large ones are ${list(largerReviews)}.`,
  dig: `A deep scan of a whole repository is ${list(DEEP_SCAN_TIERS.map((tier) => tier.credits))} credits, by its size.`,
  free: "Recon and fix checks are free while there are credits left.",
};

/** The whole price list as one paragraph. */
export const PRICE_NOTE = `${PRICES.review} ${PRICES.dig} ${PRICES.free}`;
