/**
 * Sandchest's pricing in Autumn, built from `src/plans.ts`, and the webhook
 * that sends auto top-up results and plan changes to the app. Preview with
 * `bun run autumn:push`, apply with `bun run autumn:push --yes` (sandbox), or
 * add `--prod` for production. Each environment's webhook URL comes from its
 * own variable (see `webhooksFor`). Creating a webhook writes its signing
 * secret to this package's env file (`AUTUMN_WEBHOOK_SANDCHEST_SECRET` for
 * production, `AUTUMN_WEBHOOK_SANDCHEST_SANDBOX_SECRET` for the sandbox); the
 * app reads it as AUTUMN_WEBHOOK_SECRET.
 */
import { atmn, feature, plan, webhook } from "atmn";
import { CREDIT_TIERS, CREDITS, PLAN, PLANS, TOP_UP, type Plan } from "../src/plans";

export const credits = feature({ featureId: CREDITS, name: "Credits", type: "metered", consumable: true });

/**
 * A plan's credits, sold by its pack and charged once. Autumn's auto top-up
 * buys the plan's own one-off price, so each plan carries one. Bought credits
 * never expire.
 */
const packItem = (pack: Plan["pack"]) =>
  ({ featureId: CREDITS, price: { amount: pack.price, billingUnits: pack.credits, billingMethod: "prepaid", interval: "one_off" } }) as const;

/**
 * Credits one at a time with the volume discount: the whole purchase at the
 * rate of the tier its size reaches. Auto top-ups buy through it too.
 */
const creditItem = () =>
  ({
    featureId: CREDITS,
    price: {
      tiers: CREDIT_TIERS.map((tier, i) => ({ to: CREDIT_TIERS[i + 1] ? CREDIT_TIERS[i + 1]!.from - 1 : ("inf" as const), amount: tier.price })),
      tierBehavior: "volume",
      billingUnits: 1,
      billingMethod: "prepaid",
      interval: "one_off",
    },
  }) as const;

export const plans = PLANS.map((p) =>
  plan({
    planId: p.id,
    // v2 of the current plan: credits with the volume discount.
    versionSlug: p.id === PLAN.id ? "v2" : "v1",
    active: true,
    name: p.name,
    group: "sandchest",
    price: { amount: p.price, interval: "month" },
    items: [...(p.credits > 0 ? [{ featureId: CREDITS, included: p.credits, reset: { interval: "month" } } as const] : []), p.id === PLAN.id ? creditItem() : packItem(p.pack)],
  }),
);

/** Credits on their own, with the volume discount. v1 sold packs of 25 for $10; v2 was a flat $1 each. */
export const topUp = plan({
  planId: TOP_UP.id,
  versionSlug: "v3",
  active: true,
  name: TOP_UP.name,
  addOn: true,
  items: [creditItem()],
});

/** Production's endpoint, for live Autumn. AUTUMN_WEBHOOK_URL_LIVE overrides it. */
export const LIVE_WEBHOOK_URL = "https://www.sandchest.com/api/autumn/webhooks";
const events = ["billing.auto_topup_succeeded", "billing.auto_topup_failed", "billing.updated"];

/**
 * Where each Autumn environment sends events. Live goes to production. The
 * sandbox has a webhook only when AUTUMN_WEBHOOK_URL_SANDBOX names one (a
 * preview deployment or a tunnel), so a sandbox push from a laptop can never
 * point anything at production by accident. Without it, a sandbox push
 * removes the sandbox's webhook.
 */
export function webhooksFor(env: Record<string, string | undefined>) {
  const urls = { live: env.AUTUMN_WEBHOOK_URL_LIVE || LIVE_WEBHOOK_URL, sandbox: env.AUTUMN_WEBHOOK_URL_SANDBOX || undefined };
  return (["live", "sandbox"] as const).flatMap((name) => {
    const url = urls[name];
    return url ? [webhook({ id: "sandchest", env: name, url, events, description: "Auto top-up emails and plan changes" })] : [];
  });
}

export default atmn({ features: [credits], plans: [...plans, topUp], webhooks: webhooksFor(process.env) });
