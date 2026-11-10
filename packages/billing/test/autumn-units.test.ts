import { expect, test } from "bun:test";
import config, { autumnConfig } from "../autumn/autumn.config";
import { catalog, resolveCreditUnit } from "../src/units";

const volume = (to: [number, number, number], billingUnits: number) => ({
  tiers: [
    { to: to[0], amount: 1 },
    { to: to[1], amount: 0.9 },
    { to: to[2], amount: 0.85 },
    { to: "inf", amount: 0.8 },
  ],
  tier_behavior: "volume",
  billing_units: billingUnits,
  billing_method: "prepaid",
  interval: "one_off",
});
const pack = (credits: number) => ({ amount: 10, billing_units: credits, billing_method: "prepaid", interval: "one_off" });
const retired = (id: string, name: string, price: number, included: number, packCredits: number, version: string, active: boolean) => ({
  plan_id: id,
  version_slug: version,
  active,
  name,
  group: "sandchest",
  price: { amount: price, interval: "month" },
  items: [
    { feature_id: "credits", included, reset: { interval: "month" } },
    { feature_id: "credits", price: pack(packCredits) },
  ],
});

/** Today's plans, as pushed to Autumn. */
const DOLLAR = (active: boolean) => ({
  standard: { plan_id: "standard", version_slug: "v2", active, name: "Standard", group: "sandchest", price: { amount: 1, interval: "month" }, items: [{ feature_id: "credits", price: volume([24, 49, 99], 1) }] },
  retired: [retired("lockbox", "Lockbox", 20, 60, 25, "v1", active), retired("chest", "Chest", 100, 350, 25, "v1", active), retired("vault", "Vault", 250, 1_000, 25, "v1", active)],
  topUp: { plan_id: "top_up", version_slug: "v3", active, name: "Credits", add_on: true, items: [{ feature_id: "credits", price: volume([24, 49, 99], 1) }] },
});
const TRIAL = { plan_id: "trial", version_slug: "v1", active: true, name: "Free credits", group: "sandchest", items: [] };

test("the dollar unit's Autumn config is today's", () => {
  const d = DOLLAR(true);
  expect(autumnConfig(catalog("dollar"), {}).plans).toEqual([d.standard, ...d.retired, TRIAL, d.topUp]);
});

test("the cent unit's Autumn config: packs of 100 credits at the same prices, as new versions, with today's kept inactive", () => {
  const today = DOLLAR(false);
  expect(autumnConfig(catalog("cent"), {}).plans).toEqual([
    { plan_id: "standard", version_slug: "v3", active: true, name: "Standard", group: "sandchest", price: { amount: 1, interval: "month" }, items: [{ feature_id: "credits", price: volume([2_400, 4_900, 9_900], 100) }] },
    retired("lockbox", "Lockbox", 20, 6_000, 2_500, "v2", true),
    retired("chest", "Chest", 100, 35_000, 2_500, "v2", true),
    retired("vault", "Vault", 250, 100_000, 2_500, "v2", true),
    TRIAL,
    { plan_id: "top_up", version_slug: "v4", active: true, name: "Credits", add_on: true, items: [{ feature_id: "credits", price: volume([2_400, 4_900, 9_900], 100) }] },
    today.standard,
    ...today.retired,
    today.topUp,
  ]);
});

test("the config pushed is the one for the unit the environment names", () => {
  expect(config).toEqual(autumnConfig(catalog(resolveCreditUnit()), process.env));
});
