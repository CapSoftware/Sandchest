import { expect, test } from "bun:test";
import { autoTopUpControl, billingState, createAutumn, PLANS, AutumnError } from "../src";

type Call = { path: string; body: Record<string, unknown> };

/** A fake Autumn answering each path from a script of responses. */
function fake(script: Record<string, Array<{ status: number; body?: unknown } | Error>>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace("/v1/", "");
    calls.push({ path, body: JSON.parse(String(init?.body)) });
    const next = script[path]?.shift();
    if (!next) throw new Error(`unexpected ${path}`);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
  }) as typeof fetch;
  return { calls, autumn: createAutumn({ secretKey: "k", fetch: fetchFn }) };
}

test("reserve sends a lock and reads the balance left", async () => {
  const { calls, autumn } = fake({ check: [{ status: 200, body: { allowed: true, balance: { remaining: 55 } } }] });
  const expiresAt = new Date(1_800_000_000_000);
  expect(await autumn.reserve({ customerId: "org-1", credits: 5, lockId: "scan-1", expiresAt })).toEqual({ allowed: true, remaining: 55 });
  expect(calls[0]!.body).toEqual({ customer_id: "org-1", feature_id: "credits", required_balance: 5, send_event: true, lock: { enabled: true, lock_id: "scan-1", expires_at: 1_800_000_000_000 } });
});

test("a retried reservation that already went through counts as reserved", async () => {
  const { autumn } = fake({
    check: [new TypeError("socket hang up"), { status: 409, body: { code: "lock_already_exists", message: "A lock with this ID already exists" } }],
  });
  expect(await autumn.reserve({ customerId: "o", credits: 5, lockId: "s", expiresAt: new Date() })).toEqual({ allowed: true, remaining: null });
});

test("finalizing twice is harmless; other errors are not swallowed", async () => {
  const { autumn } = fake({
    "balances.finalize": [
      { status: 400, body: { code: "invalid_request", message: "Lock not found for ID: already finalized or expired" } },
      { status: 401, body: { message: "bad key" } },
    ],
  });
  await autumn.finalize({ customerId: "o", lockId: "s", action: "confirm", credits: 3 });
  await expect(autumn.finalize({ customerId: "o", lockId: "s", action: "release" })).rejects.toBeInstanceOf(AutumnError);
});

test("reads retry on 5xx; charges never retry", async () => {
  const { calls, autumn } = fake({
    "customers.get_or_create": [{ status: 503 }, { status: 200, body: { subscriptions: [], balances: {} } }],
    "billing.attach": [{ status: 503 }],
  });
  expect((await autumn.customer("o", "acme")).planId).toBeNull();
  await expect(autumn.attach({ customerId: "o", planId: "top_up", packs: 2, successUrl: "https://x" })).rejects.toMatchObject({ status: 503 });
  expect(calls.filter((c) => c.path === "billing.attach")).toHaveLength(1);
  expect(calls.at(-1)!.body).toMatchObject({ plan_id: "top_up", feature_quantities: [{ feature_id: "credits", quantity: 50 }], redirect_mode: "if_required" });
});

test("billing state: active plan, cancellation, scheduled downgrade, auto top-up", () => {
  const state = billingState({
    subscriptions: [
      { plan_id: "chest", status: "active", past_due: false, canceled_at: 1, expires_at: null, current_period_end: 2_000, started_at: 0 },
      { plan_id: "lockbox", status: "scheduled", canceled_at: null, expires_at: null, current_period_end: null, started_at: 2_000 },
      { plan_id: "top_up", status: "active", canceled_at: null, expires_at: null, current_period_end: null, started_at: 0 },
    ],
    balances: { credits: { remaining: 41.5, next_reset_at: 2_000 } },
    billing_controls: { auto_topups: [{ feature_id: "credits", enabled: true, threshold: 30, quantity: 50, purchase_limit: { limit: 10 } }] },
  });
  expect(state).toEqual({
    planId: "chest",
    pastDue: false,
    endsAt: new Date(2_000),
    renewsAt: null,
    nextPlanId: "lockbox",
    credits: { remaining: 41, resetsAt: new Date(2_000) },
    autoTopUp: { enabled: true, threshold: 30, quantity: 50, perMonth: 10 },
  });
  expect(billingState({}).planId).toBeNull();
});

test("auto top-up: the monthly limit becomes whole top-ups; under one is off", () => {
  const [lockbox, chest] = PLANS;
  expect(autoTopUpControl(lockbox!, true, 40)).toEqual({ enabled: true, threshold: 15, quantity: 25, perMonth: 4 });
  expect(autoTopUpControl(chest!, true, 200)).toEqual({ enabled: true, threshold: 30, quantity: 50, perMonth: 10 });
  expect(autoTopUpControl(chest!, true, 15).enabled).toBe(false);
});
