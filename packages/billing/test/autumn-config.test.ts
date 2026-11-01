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
