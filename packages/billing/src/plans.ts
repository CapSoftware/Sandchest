/**
 * The plan, credits and auto top-up (SPEC §12). `autumn/autumn.config.ts` is
 * built from these, so the dashboard, the scan gate and Autumn always agree.
 *
 * One plan, $1 a month, and credits at $1 each, less in bigger purchases,
 * bought ahead and spent as the hacker works. Auto top-up buys more when the balance runs low, up to a
 * monthly limit the org can change or remove. Bought credits never expire.
 *
 * The amounts come from the catalog of the credit unit (`units.ts`): in the
 * `cent` unit every amount of credits is 100 times as many, and prices are per
 * pack of 100 credits.
 */
import { catalog, CREDIT_UNIT, type Catalog } from "./units";

const CATALOG = catalog(CREDIT_UNIT);

/** The one balance every paid scan draws from. */
export const CREDITS = "credits";

/** Credits sold for one price: 1, or 100 in the `cent` unit. Purchases are whole packs. */
export const CREDIT_PACK = CATALOG.pack;

/** USD per pack of CREDIT_PACK credits, before any volume discount. */
export const CREDIT_PRICE = CATALOG.creditPrice;

/**
 * Bigger purchases cost less per credit. A purchase is priced whole at the
 * tier its size reaches (Autumn's "volume" tiers): 25 credits are all $0.90.
 * Prices are per pack.
 */
export const CREDIT_TIERS: readonly { from: number; price: number }[] = CATALOG.creditTiers;

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
export const PLAN: Plan = CATALOG.plan;

/** Plans from before credits were sold one by one. Orgs on them keep their monthly credits. */
const RETIRED: readonly Plan[] = CATALOG.retired;

/**
 * Free credits to try Sandchest with: claimed once per account from `/claim`,
 * with no card. The plan itself is free and carries no credits; the credits
 * are a one-off grant of their own, so they stay when the account joins
 * Standard. Nothing is ever charged on it: no top-ups, no auto top-up. Once
 * the credits are spent, every scan stops until the account joins Standard.
 */
export const TRIAL: Plan = CATALOG.trial;

/** What a claim gives, and how many accounts may claim. */
export const FREE_CREDITS = {
  credits: CATALOG.freeCredits,
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
export const CREDIT_AMOUNTS: readonly number[] = CATALOG.creditAmounts;
/** The amounts offered when buying credits on a plan already joined: CREDIT_AMOUNTS, then larger ones. */
export const TOP_UP_AMOUNTS: readonly number[] = CATALOG.topUpAmounts;
/** The amount picked when nothing else is. */
export const DEFAULT_CREDITS = CATALOG.defaultCredits;
/** The most credits one purchase may hold. */
export const MAX_PURCHASE_CREDITS = CATALOG.maxPurchaseCredits;

/** Whether a purchase of this many credits is allowed: whole packs, from one pack up to MAX_PURCHASE_CREDITS. */
export function purchasable(credits: number): boolean {
  return Number.isInteger(credits) && credits >= CREDIT_PACK && credits <= MAX_PURCHASE_CREDITS && credits % CREDIT_PACK === 0;
}

/** Auto top-up buys credits once fewer than this are left: the price of the smallest Dig. */
export const TOP_UP_BELOW = CATALOG.topUpBelow;

/**
 * The most auto top-up spends in a month until the org changes it: a few hundred pull request reviews, so
 * it rarely stops a team, while a card that isn't theirs can't run up more. Orgs can raise it, lower it or
 * remove it in Settings.
 */
export const DEFAULT_TOP_UP_LIMIT_USD = 500;

export function planById(id: string | null | undefined): Plan | undefined {
  return PLANS.find((plan) => plan.id === id);
}

/** Auto top-up as Autumn runs it. `perMonth` is the most top-ups a month, or null for no limit. */
export interface AutoTopUpControl {
  enabled: boolean;
  threshold: number;
  quantity: number;
  perMonth: number | null;
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

/**
 * The price functions over one catalog. Prices are worked in whole cents, so a
 * purchase of N credits in the `cent` unit costs exactly what N/100 credits
 * cost in the `dollar` unit. The exports below are the resolved unit's.
 */
export function pricing(c: Catalog) {
  const toCents = (usd: number) => Math.round(usd * 100);
  /** USD for this many credits at a price per pack, to the cent. */
  const at = (credits: number, packPrice: number) => Math.round((credits * toCents(packPrice)) / c.pack);

  /** USD per pack in a purchase of this many credits. */
  function creditRate(credits: number): number {
    return c.creditTiers.findLast((tier) => credits >= tier.from)?.price ?? c.creditPrice;
  }

  /** USD for this many credits bought at once, with the volume discount. */
  function creditsPrice(credits: number): number {
    return at(credits, creditRate(credits)) / 100;
  }

  /** USD for this many credits at the full credit price, without any discount. */
  function creditsWorth(credits: number): number {
    return at(credits, c.creditPrice) / 100;
  }

  /** USD the volume discount takes off a purchase of this many credits. */
  function creditsSaving(credits: number): number {
    return (at(credits, c.creditPrice) - at(credits, creditRate(credits))) / 100;
  }

  /** The volume discount on a purchase of this many credits, as a whole percentage. */
  function creditsDiscount(credits: number): number {
    return Math.round((1 - creditRate(credits) / c.creditPrice) * 100);
  }

  /** What one auto top-up of `quantity` credits buys and costs on a plan: whole packs, rounded up. */
  function autoTopUpSize(plan: Plan, quantity: number): { credits: number; price: number } {
    const packs = Math.max(1, Math.ceil(quantity / plan.pack.credits));
    const credits = packs * plan.pack.credits;
    // The current plan sells its packs with the volume discount.
    if (plan.id === c.plan.id) return { credits, price: creditsPrice(credits) };
    return { credits, price: packs * plan.pack.price };
  }

  /**
   * Autumn's auto top-up control for an org's choice: buy `quantity` credits
   * when fewer than the top-up line are left, as often as needed, or as many
   * times a month as a monthly limit allows. A limit under one top-up means off.
   */
  function autoTopUpControl(plan: Plan, choice: { enabled: boolean; quantity: number; monthlyLimitUsd: number | null }): AutoTopUpControl {
    const size = autoTopUpSize(plan, choice.quantity);
    if (choice.monthlyLimitUsd === null) return { enabled: choice.enabled, threshold: c.topUpBelow, quantity: size.credits, perMonth: null };
    const perMonth = Math.floor(choice.monthlyLimitUsd / size.price);
    return { enabled: choice.enabled && perMonth >= 1, threshold: c.topUpBelow, quantity: size.credits, perMonth: Math.max(perMonth, 1) };
  }

  function creditLevel(remaining: number): CreditLevel {
    if (remaining <= 0) return "exhausted";
    return remaining < c.topUpBelow ? "low" : "ok";
  }

  return { creditRate, creditsPrice, creditsWorth, creditsSaving, creditsDiscount, autoTopUpSize, autoTopUpControl, creditLevel };
}

export const { creditRate, creditsPrice, creditsWorth, creditsSaving, creditsDiscount, autoTopUpSize, autoTopUpControl, creditLevel } = pricing(CATALOG);
