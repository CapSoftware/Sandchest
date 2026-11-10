import { expect, test } from "bun:test";
import * as billing from "../src";
import { pricing, PLANS, type Plan } from "../src/plans";
import { catalog, parseCreditUnit, resolveCreditUnit, type Catalog } from "../src/units";

const dollar = catalog("dollar");
const cent = catalog("cent");

test("the dollar unit is today's prices, value for value", () => {
  expect(dollar).toEqual({
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
  });
  const p = pricing(dollar);
  expect([10, 24, 25, 50, 100, 500].map(p.creditsPrice)).toEqual([10, 24, 22.5, 42.5, 80, 400]);
  expect([10, 25, 50, 100].map(p.creditsSaving)).toEqual([0, 2.5, 7.5, 20]);
  expect([10, 25, 50, 100].map(p.creditsDiscount)).toEqual([0, 10, 15, 20]);
  expect(p.autoTopUpSize(dollar.plan, 25)).toEqual({ credits: 25, price: 22.5 });
  expect(p.autoTopUpSize(dollar.plan, 0)).toEqual({ credits: 1, price: 1 });
  expect(p.autoTopUpSize(dollar.retired[0]!, 30)).toEqual({ credits: 50, price: 20 });
  expect([0, 1, 4, 5].map(p.creditLevel)).toEqual(["exhausted", "low", "low", "ok"]);
});

test("the cent unit: the same catalog in credits worth a cent", () => {
  expect(cent).toEqual({
    unit: "cent",
    pack: 100,
    creditPrice: 1,
    creditTiers: [
      { from: 100, price: 1 },
      { from: 2_500, price: 0.9 },
      { from: 5_000, price: 0.85 },
      { from: 10_000, price: 0.8 },
    ],
    plan: { id: "standard", name: "Standard", price: 1, credits: 0, pack: { credits: 100, price: 1 }, offered: true },
    trial: { id: "trial", name: "Free credits", price: 0, credits: 0, pack: { credits: 100, price: 1 }, offered: false },
    retired: [
      { id: "lockbox", name: "Lockbox", price: 20, credits: 6_000, pack: { credits: 2_500, price: 10 }, offered: false },
      { id: "chest", name: "Chest", price: 100, credits: 35_000, pack: { credits: 2_500, price: 10 }, offered: false },
      { id: "vault", name: "Vault", price: 250, credits: 100_000, pack: { credits: 2_500, price: 10 }, offered: false },
    ],
    freeCredits: 2_000,
    creditAmounts: [1_000, 2_500, 5_000, 10_000],
    topUpAmounts: [1_000, 2_500, 5_000, 10_000, 25_000, 50_000],
    defaultCredits: 1_000,
    maxPurchaseCredits: 100_000,
    topUpBelow: 500,
    prReviewTiers: [
      { maxLines: 500, credits: 100 },
      { maxLines: 2_000, credits: 200 },
      { maxLines: Number.POSITIVE_INFINITY, credits: 300 },
    ],
    deepScanTiers: [
      { maxLoc: 100_000, credits: 500 },
      { maxLoc: 300_000, credits: 1_000 },
      { maxLoc: 1_000_000, credits: 2_500 },
    ],
  });
});

test("every amount of credits in the cent unit is 100 times the dollar unit's, and every price the same", () => {
  const plan = (d: Plan, c: Plan) => {
    expect(c).toEqual({ ...d, credits: d.credits * 100, pack: { credits: d.pack.credits * 100, price: d.pack.price } });
  };
  expect(cent.pack).toBe(dollar.pack * 100);
  expect(cent.creditPrice).toBe(dollar.creditPrice);
  expect(cent.creditTiers).toEqual(dollar.creditTiers.map((t) => ({ from: t.from * 100, price: t.price })));
  plan(dollar.plan, cent.plan);
  plan(dollar.trial, cent.trial);
  expect(cent.retired.length).toBe(dollar.retired.length);
  dollar.retired.forEach((d, i) => plan(d, cent.retired[i]!));
  for (const key of ["freeCredits", "defaultCredits", "maxPurchaseCredits", "topUpBelow"] as const) expect(cent[key]).toBe(dollar[key] * 100);
  for (const key of ["creditAmounts", "topUpAmounts"] as const) expect(cent[key]).toEqual(dollar[key].map((n) => n * 100));
  expect(cent.prReviewTiers).toEqual(dollar.prReviewTiers.map((t) => ({ ...t, credits: t.credits * 100 })));
  expect(cent.deepScanTiers).toEqual(dollar.deepScanTiers.map((t) => ({ ...t, credits: t.credits * 100 })));
  // Nothing left out: every field is one of the above.
  expect(Object.keys(cent).sort()).toEqual(Object.keys(dollar).sort());
});

test("N credits in the cent unit cost exactly what N/100 cost in the dollar unit, for every purchase allowed", () => {
  const d = pricing(dollar);
  const c = pricing(cent);
  for (let n = cent.pack; n <= cent.maxPurchaseCredits; n += cent.pack) {
    const was = n / 100;
    expect(c.creditsPrice(n)).toBe(d.creditsPrice(was));
    expect(c.creditsSaving(n)).toBe(d.creditsSaving(was));
    expect(c.creditsDiscount(n)).toBe(d.creditsDiscount(was));
    expect(c.creditsWorth(n)).toBe(d.creditsWorth(was));
    expect(c.creditRate(n)).toBe(d.creditRate(was));
    // Whole cents, with no float drift.
    expect(Number.isInteger(Math.round(c.creditsPrice(n) * 100))).toBe(true);
    expect(c.creditsPrice(n)).toBe(Math.round(c.creditsPrice(n) * 100) / 100);
  }
  expect([1_000, 2_400, 2_500, 5_000, 10_000, 50_000].map(c.creditsPrice)).toEqual([10, 24, 22.5, 42.5, 80, 400]);
});

test("auto top-ups buy whole packs of any size, the same in both units", () => {
  const d = pricing(dollar);
  const c = pricing(cent);
  const plans = (cat: Catalog) => [cat.plan, cat.trial, ...cat.retired];
  for (const [i, plan] of plans(dollar).entries()) {
    const centPlan = plans(cent)[i]!;
    for (const quantity of [0, 1, 5, 10, 24, 25, 26, 49, 50, 99, 100, 101, 250, 500, 999, 1_000]) {
      const was = d.autoTopUpSize(plan, quantity);
      expect(c.autoTopUpSize(centPlan, quantity * 100)).toEqual({ credits: was.credits * 100, price: was.price });
      for (const monthlyLimitUsd of [null, 0, 1, 9.99, 10, 22.5, 500]) {
        const before = d.autoTopUpControl(plan, { enabled: true, quantity, monthlyLimitUsd });
        expect(c.autoTopUpControl(centPlan, { enabled: true, quantity: quantity * 100, monthlyLimitUsd })).toEqual({ ...before, threshold: before.threshold * 100, quantity: before.quantity * 100 });
      }
    }
  }
  // A quantity between packs rounds up to the next pack.
  expect(c.autoTopUpSize(cent.plan, 150)).toEqual({ credits: 200, price: 2 });
  expect(c.autoTopUpSize(cent.retired[0]!, 2_600)).toEqual({ credits: 5_000, price: 20 });
  for (const n of [-1, 0, 1, 4, 5, 6]) expect(c.creditLevel(n * 100)).toBe(d.creditLevel(n));
});

test("the exports are the catalog of the unit the environment names", () => {
  const c = catalog(resolveCreditUnit());
  expect(billing.CREDIT_UNIT).toBe(c.unit);
  expect(billing.CREDIT_PACK).toBe(c.pack);
  expect(billing.CREDIT_PRICE).toBe(c.creditPrice);
  expect(billing.CREDIT_TIERS).toEqual(c.creditTiers);
  expect(billing.PLAN).toEqual(c.plan);
  expect(billing.TRIAL).toEqual(c.trial);
  expect(PLANS).toEqual([c.plan, c.trial, ...c.retired]);
  expect(billing.FREE_CREDITS.credits).toBe(c.freeCredits);
  expect(billing.CREDIT_AMOUNTS).toEqual(c.creditAmounts);
  expect(billing.TOP_UP_AMOUNTS).toEqual(c.topUpAmounts);
  expect(billing.DEFAULT_CREDITS).toBe(c.defaultCredits);
  expect(billing.MAX_PURCHASE_CREDITS).toBe(c.maxPurchaseCredits);
  expect(billing.TOP_UP_BELOW).toBe(c.topUpBelow);
  expect(billing.PR_REVIEW_TIERS).toEqual(c.prReviewTiers);
  expect(billing.DEEP_SCAN_TIERS).toEqual(c.deepScanTiers);
  expect(billing.prReviewCredits(501)).toBe(c.prReviewTiers[1]!.credits);
  expect(billing.deepScanCredits(100_000)).toBe(c.deepScanTiers[1]!.credits);
  const p = pricing(c);
  for (const n of c.topUpAmounts) {
    expect(billing.creditsPrice(n)).toBe(p.creditsPrice(n));
    expect(billing.creditsSaving(n)).toBe(p.creditsSaving(n));
    expect(billing.autoTopUpSize(billing.PLAN, n)).toEqual(p.autoTopUpSize(c.plan, n));
  }
  expect(billing.purchasable(c.pack)).toBe(true);
  expect(billing.purchasable(c.maxPurchaseCredits)).toBe(true);
  expect(billing.purchasable(c.maxPurchaseCredits + c.pack)).toBe(false);
  expect(billing.purchasable(0)).toBe(false);
  expect(billing.purchasable(c.pack * 2.5)).toBe(false);
});

test("the unit setting: blank means cent, dollar can still be chosen, anything but dollar or cent is refused", () => {
  expect(parseCreditUnit(undefined)).toBe("cent");
  expect(parseCreditUnit("")).toBe("cent");
  expect(parseCreditUnit(" ")).toBe("cent");
  expect(parseCreditUnit("dollar")).toBe("dollar");
  expect(parseCreditUnit("cent")).toBe("cent");
  expect(() => parseCreditUnit("euro")).toThrow("NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT");
});
