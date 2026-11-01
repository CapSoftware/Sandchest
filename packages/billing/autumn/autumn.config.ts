/**
 * Sandchest's pricing in Autumn, built from `src/plans.ts`, and the webhook
 * that sends auto top-up results and plan changes to the app. Preview with
 * `bun run autumn:push`, apply with `bun run autumn:push --yes` (sandbox), or
 * add `--prod` for production. Creating the webhook writes its signing secret
 * to this package's env file (`AUTUMN_WEBHOOK_SANDCHEST_SECRET` for
 * production, `AUTUMN_WEBHOOK_SANDCHEST_SANDBOX_SECRET` for the sandbox); the
 * app reads it as AUTUMN_WEBHOOK_SECRET.
 */
import { atmn, feature, plan, webhook } from "atmn";
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

/** Where Autumn sends events. Set AUTUMN_WEBHOOK_URL to point an environment at another deployment. */
const webhookUrl = process.env.AUTUMN_WEBHOOK_URL ?? "https://www.sandchest.com/api/autumn/webhooks";
const events = ["billing.auto_topup_succeeded", "billing.auto_topup_failed", "billing.updated"];
export const webhooks = (["live", "sandbox"] as const).map((env) => webhook({ id: "sandchest", env, url: webhookUrl, events, description: "Auto top-up emails and plan changes" }));

export default atmn({ features: [credits], plans: [...plans, topUp], webhooks });
