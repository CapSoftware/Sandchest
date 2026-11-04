/**
 * The plan, credits and auto top-up (SPEC §12). `autumn/autumn.config.ts` is
 * built from these, so the dashboard, the scan gate and Autumn always agree.
 *
 * One plan, $1 a month, and credits at $1 each, less in bigger purchases,
 * bought ahead and spent as the hacker works. Auto top-up buys more when the balance runs low, up to a
 * monthly limit the org can change or remove. Bought credits never expire.
 */

/** The one balance every paid scan draws from. */
export const CREDITS = "credits";

/** USD per credit, before any volume discount. */
export const CREDIT_PRICE = 1;

/**
 * Bigger purchases cost less per credit. A purchase is priced whole at the
 * tier its size reaches (Autumn's "volume" tiers): 25 credits are all $0.90.
 */
export const CREDIT_TIERS: readonly { from: number; price: number }[] = [
  { from: 1, price: CREDIT_PRICE },
  { from: 25, price: 0.9 },
  { from: 50, price: 0.85 },
  { from: 100, price: 0.8 },
];

export type PlanId = "standard" | "trial" | "lockbox" | "chest" | "vault";

export interface Plan {
  id: PlanId;
  name: string;
  /** USD per month. */
  price: number;
  /** Credits granted each month. They do not roll over. */
  credits: number;
  /** The smallest number of credits the plan's own price sells, and its USD price. Auto top-ups buy whole packs. */
  pack: { credits: number; price: number };
  /** Sold to new customers. Older plans keep working for the orgs already on them. */
  offered: boolean;
}

/** The plan every org joins. */
export const PLAN: Plan = { id: "standard", name: "Standard", price: 1, credits: 0, pack: { credits: 1, price: CREDIT_PRICE }, offered: true };

/** Plans from before credits were sold one by one. Orgs on them keep their monthly credits. */
const RETIRED: readonly Plan[] = [
  { id: "lockbox", name: "Lockbox", price: 20, credits: 60, pack: { credits: 25, price: 10 }, offered: false },
  { id: "chest", name: "Chest", price: 100, credits: 350, pack: { credits: 25, price: 10 }, offered: false },
  { id: "vault", name: "Vault", price: 250, credits: 1_000, pack: { credits: 25, price: 10 }, offered: false },
];

/**
 * Free credits to try Sandchest with: claimed once per account from `/claim`,
 * with no card. The plan itself is free and carries no credits; the credits
 * are a one-off grant of their own, so they stay when the account joins
 * Standard. Nothing is ever charged on it: no top-ups, no auto top-up. Once
 * the credits are spent, every scan stops until the account joins Standard.
 */
export const TRIAL: Plan = { id: "trial", name: "Free credits", price: 0, credits: 0, pack: { credits: 1, price: CREDIT_PRICE }, offered: false };

/** What a claim gives, and how many accounts may claim. */
export const FREE_CREDITS = {
  credits: 20,
  /** The most accounts that can ever claim, so a shared link can't run up an unbounded bill. */
  claims: 500,
  /** Autumn's id for the grant: one per customer, so a retried claim can't grant twice. */
  balanceId: "free_credits",
} as const;

/** Whether a plan is the free one: nothing on it can be charged. */
export function isTrial(planId: string | null | undefined): boolean {
  return planId === TRIAL.id;
}

export const PLANS: readonly Plan[] = [PLAN, TRIAL, ...RETIRED];

/** Credits bought on their own, at the credit price, on any plan. */
export const TOP_UP = { id: "top_up", name: "Credits" } as const;

/** The amounts offered when buying credits. */
export const CREDIT_AMOUNTS = [10, 25, 50, 100] as const;
/** The amount picked when nothing else is. */
export const DEFAULT_CREDITS = 10;
/** The most credits one purchase may hold. */
export const MAX_PURCHASE_CREDITS = 1_000;

/** Auto top-up buys credits once fewer than this are left: the price of the smallest Dig. */
export const TOP_UP_BELOW = 5;

/**
 * The most auto top-up spends in a month until the org changes it: a few hundred pull request reviews, so
 * it rarely stops a team, while a card that isn't theirs can't run up more. Orgs can raise it, lower it or
 * remove it in Settings.
 */
export const DEFAULT_TOP_UP_LIMIT_USD = 500;

export function planById(id: string | null | undefined): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}

/** USD per credit in a purchase of this many. */
export function creditRate(credits: number): number {
  return CREDIT_TIERS.findLast((tier) => credits >= tier.from)?.price ?? CREDIT_PRICE;
}

const cents = (usd: number) => Math.round(usd * 100) / 100;

/** USD for this many credits bought at once, with the volume discount. */
export function creditsPrice(credits: number): number {
  return cents(credits * creditRate(credits));
}

/** USD the volume discount takes off a purchase of this many credits. */
export function creditsSaving(credits: number): number {
  return cents(credits * CREDIT_PRICE - creditsPrice(credits));
}

/** The volume discount on a purchase of this many credits, as a whole percentage. */
export function creditsDiscount(credits: number): number {
  return Math.round((1 - creditRate(credits) / CREDIT_PRICE) * 100);
}

/** What one auto top-up of `quantity` credits buys and costs on a plan: whole packs, rounded up. */
export function autoTopUpSize(plan: Plan, quantity: number): { credits: number; price: number } {
  const packs = Math.max(1, Math.ceil(quantity / plan.pack.credits));
  // The current plan sells credits one at a time, with the volume discount.
  if (plan.id === PLAN.id) return { credits: packs, price: creditsPrice(packs) };
  return { credits: packs * plan.pack.credits, price: packs * plan.pack.price };
}

/** Auto top-up as Autumn runs it. `perMonth` is the most top-ups a month, or null for no limit. */
export interface AutoTopUpControl {
  enabled: boolean;
  threshold: number;
  quantity: number;
  perMonth: number | null;
}

/**
 * Autumn's auto top-up control for an org's choice: buy `quantity` credits
 * when fewer than TOP_UP_BELOW are left, as often as needed, or as many
 * times a month as a monthly limit allows. A limit under one top-up means off.
 */
export function autoTopUpControl(plan: Plan, choice: { enabled: boolean; quantity: number; monthlyLimitUsd: number | null }): AutoTopUpControl {
  const size = autoTopUpSize(plan, choice.quantity);
  if (choice.monthlyLimitUsd === null) return { enabled: choice.enabled, threshold: TOP_UP_BELOW, quantity: size.credits, perMonth: null };
  const perMonth = Math.floor(choice.monthlyLimitUsd / size.price);
  return { enabled: choice.enabled && perMonth >= 1, threshold: TOP_UP_BELOW, quantity: size.credits, perMonth: Math.max(perMonth, 1) };
}

/**
 * How an org's credits stand, for the emails that warn about them:
 * - `ok`: at least TOP_UP_BELOW, the price of the smallest Dig;
 * - `low`: below it, but something left;
 * - `exhausted`: nothing left, so every paid scan is refused.
 * Ordered, so a higher level is a downward crossing.
 */
export const CREDIT_LEVELS = ["ok", "low", "exhausted"] as const;
export type CreditLevel = (typeof CREDIT_LEVELS)[number];

export function creditLevel(remaining: number): CreditLevel {
  if (remaining <= 0) return "exhausted";
  return remaining < TOP_UP_BELOW ? "low" : "ok";
}
