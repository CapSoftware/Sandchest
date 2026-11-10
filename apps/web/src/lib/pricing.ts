/**
 * How pricing is put into words, from the cost table itself, so every page
 * that explains it says the same thing and stays right when it changes.
 */
import { CREDIT_PACK, CREDIT_PRICE, CREDIT_TIERS, PLAN } from "@sandchest/billing/plans";
import { creditCount, creditsText, usd } from "./format";

const and = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`);

/** A price for credits as said: "$1 each", or "$1 per 100" where credits are sold by the 100. */
export function perCredit(price: number): string {
  return CREDIT_PACK === 1 ? `${usd(price)} each` : `${usd(price)} per ${creditCount(CREDIT_PACK)}`;
}

/** What a pull request review costs, as said after "A review is". What is typical, never a promise. */
export const PR_REVIEW_COST = "charged for what it uses, usually a few credits or less";

/** What a pull request review is charged in examples on the site: a few credits. */
export const EXAMPLE_REVIEW_CREDITS = 2;

/** The volume discounts after the base price, e.g. ["25 or more at once are $0.90 each", "50 or more $0.85", …]. */
const bulk = CREDIT_TIERS.slice(1).map((tier, i) => (i === 0 ? `${creditCount(tier.from)} or more at once are ${perCredit(tier.price)}` : `${creditCount(tier.from)} or more ${usd(tier.price)}`));

/** One sentence each: the plan, credit prices, what a review usually costs, what a deep scan usually costs, what is free. */
export const PRICES = {
  plan: `${usd(PLAN.price)} a month, and credits are ${perCredit(CREDIT_PRICE)}, less in bulk.`,
  credits: `Credits are ${perCredit(CREDIT_PRICE)}${bulk.length ? `; ${and(bulk)}` : ""}.`,
  review: "A pull request review is charged for what it uses: usually a few credits or less, and nothing when it changes nothing security-relevant.",
  dig: `A deep scan of a whole repository usually costs well under ${creditsText(CREDIT_PACK)}, and shows the most it can cost before it starts.`,
  free: "Recon and fix checks are free while there are credits left.",
};

/** The whole price list as one paragraph. */
export const PRICE_NOTE = `${PRICES.review} ${PRICES.dig} ${PRICES.free}`;
