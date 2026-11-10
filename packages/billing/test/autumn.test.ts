import { expect, test } from "bun:test";
import { billingState, createAutumn, planById, autoTopUpControl, AutumnError } from "../src";

type Call = { path: string; body: Record<string, unknown>; headers: Headers };

/** A fake Autumn answering each path from a script of responses. */
function fake(script: Record<string, Array<{ status: number; body?: unknown } | Error>>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace("/v1/", "");
    calls.push({ path, body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
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

test("an org that was never a customer is refused, not an error", async () => {
  const { autumn } = fake({ check: [{ status: 404, body: { code: "customer_not_found", message: "Customer does not exist in this org and env" } }] });
  expect(await autumn.reserve({ customerId: "new", credits: 1, lockId: "s", expiresAt: new Date() })).toEqual({ allowed: false, remaining: null });
});

test("finalizing twice is harmless; other errors are not swallowed", async () => {
  const { autumn } = fake({
    "balances.finalize": [
      { status: 400, body: { code: "invalid_request", message: "Lock not found for ID: already finalized or expired" } },
      { status: 400, body: { code: "invalid_request", message: "Lock not found for ID: s" } },
      { status: 401, body: { message: "bad key" } },
    ],
  });
  await autumn.finalize({ customerId: "o", lockId: "s", action: "confirm", credits: 3 });
  await autumn.finalize({ customerId: "o", lockId: "s", action: "release" });
  await expect(autumn.finalize({ customerId: "o", lockId: "s", action: "release" })).rejects.toBeInstanceOf(AutumnError);
});

test("reads retry on 5xx; charges never retry", async () => {
  const { calls, autumn } = fake({
    "customers.get_or_create": [{ status: 503 }, { status: 200, body: { subscriptions: [], balances: {} } }],
    "billing.attach": [{ status: 503 }],
  });
  expect((await autumn.customer("o", "acme")).planId).toBeNull();
  await expect(autumn.attach({ customerId: "o", planId: "top_up", credits: 50, successUrl: "https://x" })).rejects.toMatchObject({ status: 503 });
  expect(calls.filter((c) => c.path === "billing.attach")).toHaveLength(1);
  expect(calls.at(-1)!.body).toMatchObject({ plan_id: "top_up", feature_quantities: [{ feature_id: "credits", quantity: 50 }], redirect_mode: "if_required" });
});

test("a confirmed purchase goes under its idempotency key, and a repeat of the key charges nothing more", async () => {
  const { calls, autumn } = fake({
    "billing.attach": [
      { status: 200, body: { payment_url: null } },
      { status: 409, body: { message: "Duplicate request" } },
      { status: 409, body: { code: "plan_already_attached", message: "Cannot attach because the customer's current product is the same as the product being attached" } },
      { status: 409, body: { message: "Duplicate request" } },
    ],
  });
  const purchase = { customerId: "o", planId: "top_up" as const, credits: 50, successUrl: "https://x", idempotencyKey: "purchase-1" };
  expect(await autumn.attach(purchase)).toEqual({ paymentUrl: null });
  expect(await autumn.attach(purchase)).toEqual({ paymentUrl: null, repeated: true });
  expect(calls.map((c) => c.headers.get("idempotency-key"))).toEqual(["purchase-1", "purchase-1"]);
  // Any other refusal is still an error, and without a key a 409 is never taken for a repeat.
  await expect(autumn.attach({ ...purchase, planId: "standard" })).rejects.toMatchObject({ status: 409, code: "plan_already_attached" });
  await expect(autumn.attach({ customerId: "o", planId: "top_up", credits: 50, successUrl: "https://x" })).rejects.toMatchObject({ status: 409 });
  expect(calls.at(-1)!.headers.get("idempotency-key")).toBeNull();
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

test("auto top-up: the monthly limit becomes whole top-ups; under one is off; none means no limit", () => {
  const standard = planById("standard")!;
  expect(autoTopUpControl(standard, { enabled: true, quantity: 1_000, monthlyLimitUsd: null })).toEqual({ enabled: true, threshold: 500, quantity: 1_000, perMonth: null });
  expect(autoTopUpControl(standard, { enabled: true, quantity: 1_000, monthlyLimitUsd: 50 })).toEqual({ enabled: true, threshold: 500, quantity: 1_000, perMonth: 5 });
  expect(autoTopUpControl(standard, { enabled: true, quantity: 2_500, monthlyLimitUsd: 60 })).toEqual({ enabled: true, threshold: 500, quantity: 2_500, perMonth: 2 });
  expect(autoTopUpControl(standard, { enabled: true, quantity: 2_500, monthlyLimitUsd: 20 }).enabled).toBe(false);
  // Older plans sell credits in packs of 2,500 for $10: a top-up rounds up to whole packs.
  expect(autoTopUpControl(planById("chest")!, { enabled: true, quantity: 1_000, monthlyLimitUsd: 40 })).toEqual({ enabled: true, threshold: 500, quantity: 2_500, perMonth: 4 });
});

test("auto top-up without a monthly limit sends no purchase limit, which clears one set before", async () => {
  const { calls, autumn } = fake({ "customers.update": [{ status: 200, body: {} }, { status: 200, body: {} }] });
  await autumn.setAutoTopUp("o", { enabled: true, threshold: 5, quantity: 10, perMonth: 3 });
  await autumn.setAutoTopUp("o", { enabled: true, threshold: 5, quantity: 10, perMonth: null });
  const sent = calls.map((c) => (c.body as { billing_controls: { auto_topups: Record<string, unknown>[] } }).billing_controls.auto_topups[0]);
  expect(sent[0]).toMatchObject({ purchase_limit: { interval: "month", interval_count: 1, limit: 3 } });
  expect(sent[1]).toEqual({ feature_id: "credits", enabled: true, threshold: 5, quantity: 10 });
  expect(billingState({ billing_controls: { auto_topups: [{ feature_id: "credits", enabled: true, threshold: 5, quantity: 10 }] } }).autoTopUp).toEqual({ enabled: true, threshold: 5, quantity: 10, perMonth: null });
});

test("with a plan, credits are bought only when asked for", async () => {
  const { calls, autumn } = fake({ "billing.attach": [{ status: 200, body: { payment_url: null } }, { status: 200, body: { payment_url: null } }] });
  await autumn.attach({ customerId: "o", planId: "standard", credits: 25, successUrl: "https://x" });
  await autumn.attach({ customerId: "o", planId: "standard", successUrl: "https://x" });
  expect(calls.map((c) => (c.body as { feature_quantities?: unknown }).feature_quantities)).toEqual([[{ feature_id: "credits", quantity: 25 }], undefined]);
});

// Answers measured against Autumn's sandbox (2026-11-03).
test("a grant is one balance under its own id; granting again is harmless, other errors are not", async () => {
  const { calls, autumn } = fake({
    "balances.create": [
      { status: 200, body: { success: true } },
      { status: 409, body: { code: "invalid_request", message: "balance_id 'free_credits' is already in use for this customer" } },
      { status: 400, body: { code: "invalid_request", message: "Feature not found" } },
    ],
  });
  await autumn.grant({ customerId: "org-1", credits: 20, balanceId: "free_credits" });
  expect(calls[0]!.body).toEqual({ customer_id: "org-1", feature_id: "credits", included_grant: 20, balance_id: "free_credits" });
  await autumn.grant({ customerId: "org-1", credits: 20, balanceId: "free_credits" });
  await expect(autumn.grant({ customerId: "org-1", credits: 20, balanceId: "free_credits" })).rejects.toBeInstanceOf(AutumnError);
});

test("check asks for a balance without holding or spending any", async () => {
  const { calls, autumn } = fake({
    check: [
      { status: 200, body: { allowed: true, balance: { remaining: 20 } } },
      { status: 200, body: { allowed: false, balance: { remaining: 0 } } },
      { status: 404, body: { code: "customer_not_found", message: "Customer does not exist" } },
    ],
  });
  expect(await autumn.check("org-1", 1)).toEqual({ allowed: true, remaining: 20 });
  expect(calls[0]!.body).toEqual({ customer_id: "org-1", feature_id: "credits", required_balance: 1 });
  expect(await autumn.check("org-1", 1)).toEqual({ allowed: false, remaining: 0 });
  expect(await autumn.check("new", 1)).toEqual({ allowed: false, remaining: null });
});

test("the free plan reads as a plan, and the granted credits count toward the balance", () => {
  const state = billingState({
    subscriptions: [{ plan_id: "trial", status: "active", canceled_at: null, expires_at: null, current_period_end: null, started_at: 1 }],
    balances: { credits: { remaining: 20, next_reset_at: null } },
  });
  expect(state.planId).toBe("trial");
  expect(state.credits).toEqual({ remaining: 20, resetsAt: null });
  expect(state.renewsAt).toBeNull();
});
