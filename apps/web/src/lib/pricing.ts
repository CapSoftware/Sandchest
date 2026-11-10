/**
 * How pricing is put into words, from the cost table itself, so every page
 * that explains it says the same thing and stays right when it changes.
 * People read amounts in US dollars (`money`); the agent API still speaks in
 * credits, and its two phrases are kept here as it says them.
 */
import { CREDIT_PACK, CREDIT_TIERS, creditsDiscount, creditsPrice, creditsWorth, PLAN } from "@sandchest/billing/plans";
import { money, usd } from "./format";

const and = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`);

/** A price for credits as the agent API says it: "$1 each", or "$1 per 100" where credits are sold by the 100. */
export function perCredit(price: number): string {
  return CREDIT_PACK === 1 ? `${usd(price)} each` : `${usd(price)} per ${CREDIT_PACK.toLocaleString("en-US")}`;
}

/** What a pull request review costs, as the agent API says it after "each". */
export const PR_REVIEW_COST = "charged for what it uses, usually a few credits or less";

/** A few credits, as money: "a few cents" where a credit is a cent. */
export const A_FEW = CREDIT_PACK === 1 ? "a few dollars" : "a few cents";

/** What a pull request review costs, as said after "A review is". What is typical, never a promise. */
export const PR_REVIEW_PRICE = `charged for what it uses, usually ${A_FEW} or less`;

/** What a pull request review is charged in examples on the site: a few credits. */
export const EXAMPLE_REVIEW_CREDITS = 2;

/** The volume discounts, e.g. ["$25 or more at once for 10% less", "$50 or more for 15% less", …]. */
const bulk = CREDIT_TIERS.slice(1).map((tier, i) => `${usd(creditsWorth(tier.from))} or more${i === 0 ? " at once" : ""} for ${creditsDiscount(tier.from)}% less`);

/** One sentence each: the plan, what adding funds costs, what a review usually costs, what a deep scan usually costs, what is free. */
export const PRICES = {
  plan: `${usd(PLAN.price)} a month, plus what your scans use, paid from your balance.`,
  credits: bulk.length ? `Add ${and(bulk)}.` : "",
  review: `A pull request review is charged for what it uses: usually ${A_FEW} or less, and nothing when it changes nothing security-relevant.`,
  dig: `A deep scan of a whole repository usually costs well under ${usd(creditsWorth(CREDIT_PACK))}, and shows the most it can cost before it starts.`,
  free: "Recon and fix checks are free while there is balance left.",
};

/** The whole price list as one paragraph. */
export const PRICE_NOTE = `${PRICES.review} ${PRICES.dig} ${PRICES.free}`;

/** Funds as they are sold: the balance added, and its price where a bigger purchase costs less. "$10.00", "$25.00 for $22.50". */
export function fundsFor(credits: number, price = creditsPrice(credits)): string {
  return price === creditsWorth(credits) ? money(credits) : `${money(credits)} for ${usd(price, true)}`;
}

/**
 * What a scan billed from its usage says about cost before it starts: what this repository's last one was
 * charged, from its bill, or what one usually comes to; then that it is charged for what it uses. `fast`: a
 * fast scan, whose cost neither figure describes.
 */
export function usageCost(last?: number, fast = false): string {
  const pays = "You pay only for what it uses.";
  if (fast) return pays;
  return `${last === undefined ? `Usually well under ${usd(creditsWorth(CREDIT_PACK))}.` : `The last scan here cost ${money(last)}.`} ${pays}`;
}

/** What a scan priced by the repository's size says before it starts. `unsized`: not measured yet, so the most it can be is set aside. */
export function sizePrice(credits: number, unsized: boolean): string {
  return unsized ? `Priced by the repository’s size once it is measured. ${money(credits)} of your balance is set aside until then.` : `This scan costs ${money(credits)}.`;
}

/**
 * Too little in the balance for what a scan or review holds. `has`: what the account holds, said when it is known
 * and really is less.
 */
export function notEnoughBalance(what: "scan" | "review", need: number, login: string, has?: number | null): string {
  const held = has !== undefined && has !== null && has < need ? `, ${login} has ${money(Math.max(has, 0))}` : "";
  return `Not enough balance: this ${what} needs ${money(need)} available${held}.`;
}
