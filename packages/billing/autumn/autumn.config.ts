/**
 * Sandchest's pricing in Autumn, built from `src/plans.ts`. Preview with
 * `bun run autumn:push`, apply with `bun run autumn:push --yes` (sandbox), or
 * add `--prod` for production.
 */
import { atmn, feature, plan } from "atmn";
import { CREDITS, PLANS, TOP_UP } from "../src/plans";

export const credits = feature({ featureId: CREDITS, name: "Credits", type: "metered", consumable: true });

/** One top-up pack, charged once. Plans carry it too: Autumn's auto top-up buys the plan's own one-off price. */
const topUpItem = {
  featureId: CREDITS,
  price: { amount: TOP_UP.price, billingUnits: TOP_UP.credits, billingMethod: "prepaid", interval: "one_off" },
} as const;

export const plans = PLANS.map((p) =>
  plan({
    planId: p.id,
    versionSlug: "v1",
    active: true,
    name: p.name,
    group: "sandchest",
    price: { amount: p.price, interval: "month" },
    items: [{ featureId: CREDITS, included: p.credits, reset: { interval: "month" } }, topUpItem],
  }),
);

export const topUp = plan({
  planId: TOP_UP.id,
  versionSlug: "v1",
  active: true,
  name: TOP_UP.name,
  addOn: true,
  items: [topUpItem],
});

export default atmn({ features: [credits], plans: [...plans, topUp] });
