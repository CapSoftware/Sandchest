/**
 * The plans and top-ups (SPEC §12). `autumn/autumn.config.ts` is built from
 * these, so the dashboard, the scan gate and Autumn always agree.
 */

/** The one balance every paid scan draws from. */
export const CREDITS = "credits";

export type PlanId = "lockbox" | "chest" | "vault";

export interface Plan {
  id: PlanId;
  name: string;
  /** USD per month. */
  price: number;
  /** Credits granted each month. They do not roll over. */
  credits: number;
  /** Auto top-up buys `packs` top-ups when the balance falls below `below`: enough for this plan's typical scan. */
  autoTopUp: { below: number; packs: number };
}

export const PLANS: readonly Plan[] = [
  { id: "lockbox", name: "Lockbox", price: 20, credits: 60, autoTopUp: { below: 15, packs: 1 } },
  { id: "chest", name: "Chest", price: 100, credits: 350, autoTopUp: { below: 30, packs: 2 } },
  { id: "vault", name: "Vault", price: 250, credits: 1_000, autoTopUp: { below: 75, packs: 3 } },
];

/** A top-up pack: never cheaper per credit than a plan. Bought credits never expire. */
export const TOP_UP = { id: "top_up", name: "Top-up", credits: 25, price: 10 } as const;

/** The most top-up packs one purchase may hold. */
export const MAX_TOP_UP_PACKS = 20;

export function planById(id: string | null | undefined): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}

/** The default monthly auto top-up limit: twice the plan's price. */
export function defaultAutoTopUpLimit(plan: Plan): number {
  return plan.price * 2;
}

/**
 * Autumn's auto top-up control for a plan and a monthly spend limit in USD.
 * The limit is a whole number of top-ups per month; under one top-up means off.
 */
export function autoTopUpControl(plan: Plan, enabled: boolean, monthlyLimitUsd: number): { enabled: boolean; threshold: number; quantity: number; perMonth: number } {
  const perMonth = Math.floor(monthlyLimitUsd / autoTopUpPrice(plan));
  return { enabled: enabled && perMonth >= 1, threshold: plan.autoTopUp.below, quantity: plan.autoTopUp.packs * TOP_UP.credits, perMonth: Math.max(perMonth, 1) };
}

/**
 * How an org's credits stand, for the emails that warn about them:
 * - `ok`: at least the plan's low line, which is about one typical deep scan
 *   for the plan (15, 30 or 75 credits) and the same line auto top-up buys at;
 * - `low`: below it, but something left;
 * - `exhausted`: nothing left, so every paid scan is refused.
 * Ordered, so a higher level is a downward crossing.
 */
export const CREDIT_LEVELS = ["ok", "low", "exhausted"] as const;
export type CreditLevel = (typeof CREDIT_LEVELS)[number];

export function creditLevel(plan: Plan, remaining: number): CreditLevel {
  if (remaining <= 0) return "exhausted";
  return remaining < plan.autoTopUp.below ? "low" : "ok";
}

/** USD charged by one auto top-up on this plan. */
export function autoTopUpPrice(plan: Plan): number {
  return plan.autoTopUp.packs * TOP_UP.price;
}
