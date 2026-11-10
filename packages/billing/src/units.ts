/**
 * What one credit is worth, and every price-bearing value in credits for it.
 * Today a credit is a dollar. In the `cent` unit every amount of credits is
 * 100 times as many and every US dollar price stays the same: credits are
 * sold in packs of 100 at today's price for one.
 *
 * The unit comes from NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT (`dollar`, the
 * default, or `cent`). `plans.ts` and `costs.ts` export the resolved unit's
 * catalog, so every surface and the Autumn config read the same numbers.
 */
import type { Plan } from "./plans";

export type CreditUnit = "dollar" | "cent";

/** A setting's value as a unit: blank means unset, which is `dollar`. Anything else is refused, as the app's config refuses it. */
export function parseCreditUnit(value: string | undefined): CreditUnit {
  if (value === undefined || value.trim() === "") return "dollar";
  if (value === "dollar" || value === "cent") return value;
  throw new Error("NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: must be dollar or cent");
}

/**
 * The unit this process runs in. Next inlines this exact expression at build,
 * in server and browser code alike, so both render the same prices. The Autumn
 * CLI and tests read it from the environment when this module loads.
 */
export function resolveCreditUnit(): CreditUnit {
  return parseCreditUnit(process.env.NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT);
}

/** Every value with credits or a price in it, in one unit. */
export interface Catalog {
  unit: CreditUnit;
  /** Credits sold for one price: one, or a pack of 100. Purchases are whole packs. */
  pack: number;
  /** USD for one pack, before any volume discount. */
  creditPrice: number;
  /** The volume tiers: from this many credits, this USD per pack. */
  creditTiers: readonly { from: number; price: number }[];
  plan: Plan;
  trial: Plan;
  retired: readonly Plan[];
  /** Credits a free claim gives. */
  freeCredits: number;
  /** The amounts offered when joining, and first when buying credits. */
  creditAmounts: readonly number[];
  /** The amounts offered when buying credits on a plan already joined: the ones above, then larger. */
  topUpAmounts: readonly number[];
  defaultCredits: number;
  maxPurchaseCredits: number;
  topUpBelow: number;
  prReviewTiers: ReadonlyArray<{ maxLines: number; credits: number }>;
  deepScanTiers: ReadonlyArray<{ maxLoc: number; credits: number }>;
}

const DOLLAR: Catalog = {
  unit: "dollar",
  pack: 1,
  creditPrice: 1,
  creditTiers: [
    { from: 1, price: 1 },
    { from: 25, price: 0.9 },
    { from: 50, price: 0.85 },
    { from: 100, price: 0.8 },
  ],
  plan: { id: "standard", name: "Standard", price: 1, credits: 0, pack: { credits: 1, price: 1 }, offered: true },
  trial: { id: "trial", name: "Free credits", price: 0, credits: 0, pack: { credits: 1, price: 1 }, offered: false },
  retired: [
    { id: "lockbox", name: "Lockbox", price: 20, credits: 60, pack: { credits: 25, price: 10 }, offered: false },
    { id: "chest", name: "Chest", price: 100, credits: 350, pack: { credits: 25, price: 10 }, offered: false },
    { id: "vault", name: "Vault", price: 250, credits: 1_000, pack: { credits: 25, price: 10 }, offered: false },
  ],
  freeCredits: 20,
  creditAmounts: [10, 25, 50, 100],
  topUpAmounts: [10, 25, 50, 100, 250, 500],
  defaultCredits: 10,
  maxPurchaseCredits: 1_000,
  topUpBelow: 5,
  prReviewTiers: [
    { maxLines: 500, credits: 1 },
    { maxLines: 2_000, credits: 2 },
    { maxLines: Number.POSITIVE_INFINITY, credits: 3 },
  ],
  deepScanTiers: [
    { maxLoc: 100_000, credits: 5 },
    { maxLoc: 300_000, credits: 10 },
    { maxLoc: 1_000_000, credits: 25 },
  ],
};

/** The same catalog with every amount of credits times `n` and every price unchanged. */
function scaled(c: Catalog, unit: CreditUnit, n: number): Catalog {
  const plan = (p: Plan): Plan => ({ ...p, credits: p.credits * n, pack: { credits: p.pack.credits * n, price: p.pack.price } });
  return {
    unit,
    pack: c.pack * n,
    creditPrice: c.creditPrice,
    creditTiers: c.creditTiers.map((tier) => ({ from: tier.from * n, price: tier.price })),
    plan: plan(c.plan),
    trial: plan(c.trial),
    retired: c.retired.map(plan),
    freeCredits: c.freeCredits * n,
    creditAmounts: c.creditAmounts.map((amount) => amount * n),
    topUpAmounts: c.topUpAmounts.map((amount) => amount * n),
    defaultCredits: c.defaultCredits * n,
    maxPurchaseCredits: c.maxPurchaseCredits * n,
    topUpBelow: c.topUpBelow * n,
    prReviewTiers: c.prReviewTiers.map((tier) => ({ maxLines: tier.maxLines, credits: tier.credits * n })),
    deepScanTiers: c.deepScanTiers.map((tier) => ({ maxLoc: tier.maxLoc, credits: tier.credits * n })),
  };
}

const CATALOGS: Record<CreditUnit, Catalog> = { dollar: DOLLAR, cent: scaled(DOLLAR, "cent", 100) };

export function catalog(unit: CreditUnit): Catalog {
  return CATALOGS[unit];
}

/** The unit this process runs in, read once. */
export const CREDIT_UNIT: CreditUnit = resolveCreditUnit();

/**
 * Each plan's version slug in Autumn, by credit unit. Autumn versions plans, so a plan whose credits change in
 * the `cent` unit has a version of its own. The trial carries no credits or prices, so it keeps its version.
 */
export const AUTUMN_VERSIONS: Record<CreditUnit, Record<Plan["id"] | "top_up", string>> = {
  // v2 of the current plan: credits with the volume discount. Credits on their own: v1 sold packs of 25 for $10; v2 was a flat $1 each.
  dollar: { standard: "v2", trial: "v1", lockbox: "v1", chest: "v1", vault: "v1", top_up: "v3" },
  // A credit is a cent: every amount of credits times 100, at the same prices.
  cent: { standard: "v3", trial: "v1", lockbox: "v2", chest: "v2", vault: "v2", top_up: "v4" },
};
