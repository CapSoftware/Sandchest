import { expect, test } from "bun:test";
import { LIVE_WEBHOOK_URL, webhooksFor } from "../autumn/autumn.config";

const where = (env: Record<string, string | undefined>) => webhooksFor(env).map((w) => [w.env, w.url]);

test("live Autumn sends events to production; the sandbox has no webhook unless its own URL is set", () => {
  expect(where({})).toEqual([["live", LIVE_WEBHOOK_URL]]);
  // The old shared variable no longer points the sandbox anywhere.
  expect(where({ AUTUMN_WEBHOOK_URL: "https://www.sandchest.com/api/autumn/webhooks" })).toEqual([["live", LIVE_WEBHOOK_URL]]);
  expect(where({ AUTUMN_WEBHOOK_URL_SANDBOX: "" })).toEqual([["live", LIVE_WEBHOOK_URL]]);
});

test("each environment takes its URL from its own variable", () => {
  expect(where({ AUTUMN_WEBHOOK_URL_SANDBOX: "https://preview.example.com/api/autumn/webhooks", AUTUMN_WEBHOOK_URL_LIVE: "https://app.example.com/api/autumn/webhooks" })).toEqual([
    ["live", "https://app.example.com/api/autumn/webhooks"],
    ["sandbox", "https://preview.example.com/api/autumn/webhooks"],
  ]);
  for (const hook of webhooksFor({ AUTUMN_WEBHOOK_URL_SANDBOX: "https://preview.example.com/x" })) {
    expect(hook.events).toEqual(["billing.auto_topup_succeeded", "billing.auto_topup_failed", "billing.updated"]);
  }
});

test("Standard and credits on their own sell with the volume discount, as tiers Autumn charges", async () => {
  const { plans, topUp } = await import("../autumn/autumn.config");
  const standard = plans.find((p) => p.planId === "standard")!;
  for (const item of [standard.items!.at(-1)!, topUp.items![0]!]) {
    expect(item.price).toMatchObject({
      tierBehavior: "volume",
      billingMethod: "prepaid",
      interval: "one_off",
      billingUnits: 100,
      tiers: [
        { to: 2_400, amount: 1 },
        { to: 4_900, amount: 0.9 },
        { to: 9_900, amount: 0.85 },
        { to: "inf", amount: 0.8 },
      ],
    });
  }
});
