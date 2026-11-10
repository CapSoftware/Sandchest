/**
 * Sandchest's pricing in Autumn, built from `src/plans.ts`, and the webhook
 * that sends auto top-up results and plan changes to the app. Preview with
 * `bun run autumn:push`, apply with `bun run autumn:push --yes` (sandbox), or
 * add `--prod` for production. Each environment's webhook URL comes from its
 * own variable (see `webhooksFor`). Creating a webhook writes its signing
 * secret to this package's env file (`AUTUMN_WEBHOOK_SANDCHEST_SECRET` for
 * production, `AUTUMN_WEBHOOK_SANDCHEST_SANDBOX_SECRET` for the sandbox); the
 * app reads it as AUTUMN_WEBHOOK_SECRET.
 *
 * The prices are the catalog of NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT, read from
 * the environment the CLI runs in: set it as the app's deployment sets it.
 */
import { atmn, feature, plan, webhook } from "atmn";
import { CREDITS, TOP_UP, type Plan } from "../src/plans";
import { catalog, CREDIT_UNIT, type Catalog, type CreditUnit } from "../src/units";

export const credits = feature({ featureId: CREDITS, name: "Credits", type: "metered", consumable: true });

/**
 * Each plan's version in Autumn, by credit unit. Autumn versions plans, so a
 * plan whose credits change in the `cent` unit gets a new version, and the
 * `cent` config states the old one too, inactive: a push removes every version
 * it leaves out, and the customers on the old one keep it until they are moved.
 * The trial carries no credits or prices, so it keeps its version.
 */
const VERSIONS: Record<CreditUnit, Record<Plan["id"] | typeof TOP_UP.id, string>> = {
  // v2 of the current plan: credits with the volume discount. Credits on their own: v1 sold packs of 25 for $10; v2 was a flat $1 each.
  dollar: { standard: "v2", trial: "v1", lockbox: "v1", chest: "v1", vault: "v1", top_up: "v3" },
  // A credit is a cent: every amount of credits times 100, at the same prices.
  cent: { standard: "v3", trial: "v1", lockbox: "v2", chest: "v2", vault: "v2", top_up: "v4" },
};

/** Sandchest's plans and the credits add-on in Autumn, for one unit's catalog. `active` is false for versions kept only for the customers still on them. */
export function autumnPlans(c: Catalog, active = true) {
  const versions = VERSIONS[c.unit];

  /**
   * A plan's credits, sold by its pack and charged once. Autumn's auto top-up
   * buys the plan's own one-off price, so each plan carries one. Bought credits
   * never expire.
   */
  const packItem = (pack: Plan["pack"]) =>
    ({ featureId: CREDITS, price: { amount: pack.price, billingUnits: pack.credits, billingMethod: "prepaid", interval: "one_off" } }) as const;

  /**
   * Credits by the pack with the volume discount: the whole purchase at the
   * rate of the tier its size reaches. Auto top-ups buy through it too.
   */
  const creditItem = () =>
    ({
      featureId: CREDITS,
      price: {
        tiers: c.creditTiers.map((tier, i) => ({ to: c.creditTiers[i + 1] ? c.creditTiers[i + 1]!.from - c.pack : ("inf" as const), amount: tier.price })),
        tierBehavior: "volume",
        billingUnits: c.pack,
        billingMethod: "prepaid",
        interval: "one_off",
      },
    }) as const;

  /**
   * The free plan behind claimed credits: no price and no items, so attaching
   * it never asks for a card. The credits are granted on their own (see
   * FREE_CREDITS), and joining Standard replaces the plan but keeps them.
   */
  const trial = plan({ planId: c.trial.id, versionSlug: versions.trial, active, name: c.trial.name, group: "sandchest", items: [] });

  const plans = [c.plan, ...c.retired].map((p) =>
    plan({
      planId: p.id,
      versionSlug: versions[p.id],
      active,
      name: p.name,
      group: "sandchest",
      price: { amount: p.price, interval: "month" },
      items: [...(p.credits > 0 ? [{ featureId: CREDITS, included: p.credits, reset: { interval: "month" } } as const] : []), p.id === c.plan.id ? creditItem() : packItem(p.pack)],
    }),
  );

  /** Credits on their own, with the volume discount. */
  const topUp = plan({
    planId: TOP_UP.id,
    versionSlug: versions.top_up,
    active,
    name: TOP_UP.name,
    addOn: true,
    items: [creditItem()],
  });

  return { plans, trial, topUp };
}

export const { plans, trial, topUp } = autumnPlans(catalog(CREDIT_UNIT));

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

/**
 * The whole Autumn config for a unit's catalog. In the `cent` unit it also
 * states the dollar versions, inactive, so pushing it keeps them for the
 * customers still on them (the trial is the same version in both).
 */
export function autumnConfig(c: Catalog, env: Record<string, string | undefined>) {
  const { plans, trial, topUp } = autumnPlans(c);
  const kept = c.unit === "cent" ? autumnPlans(catalog("dollar"), false) : undefined;
  return atmn({ features: [credits], plans: [...plans, trial, topUp, ...(kept ? [...kept.plans, kept.topUp] : [])], webhooks: webhooksFor(env) });
}

export default autumnConfig(catalog(CREDIT_UNIT), process.env);
