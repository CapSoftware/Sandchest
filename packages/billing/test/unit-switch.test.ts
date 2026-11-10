/**
 * The provider side of the credit unit switch against an in-memory Autumn that moves plans and sets balances the
 * way the sandbox did (2026-11-10): a move keeps a one-off bucket's number under a new id and refills a monthly
 * one to the new allowance less its usage; `balances.update` sets a bucket outright.
 */
import { describe, expect, test } from "bun:test";
import { customerState, restoreTopUp, switchCustomer, SwitchStopped, undoCustomer, type Bucket, type CustomerState, type JournalEntry, type SwitchApi, type SwitchJournal, type SwitchRecord, type SwitchStep, type TopUpControl } from "../src/unit-switch";

const VERSIONS = { dollar: { standard: 1, trial: 1, lockbox: 1, chest: 1, vault: 1, top_up: 2 }, cent: { standard: 2, trial: 1, lockbox: 2, chest: 2, vault: 2, top_up: 3 } };
const MONTHLY: Record<string, Record<number, number>> = { lockbox: { 1: 60, 2: 6_000 } };

class FakeSwitchApi implements SwitchApi {
  readonly environment = "sandbox" as const;
  readonly baseUrl = "https://autumn.test";
  readonly customers = new Map<string, CustomerState>();
  readonly writes: string[] = [];
  /** Throw on the nth write from now (1 = the next), as a process killed mid-run. */
  crashAt = 0;
  /** Whether the killed write took effect first, as when the answer is lost. */
  crashAfter = false;
  charge = 0;
  private next = 0;

  private write(what: string, apply: () => void) {
    const crash = this.crashAt > 0 && --this.crashAt === 0;
    if (crash && !this.crashAfter) throw new Error("killed");
    this.writes.push(what);
    apply();
    if (crash) throw new Error("killed");
  }
  async customerIds() {
    return [...this.customers.keys()];
  }
  async customer(id: string) {
    return structuredClone(this.customers.get(id)!);
  }
  async versions() {
    return VERSIONS;
  }
  async setTopUp(id: string, control: TopUpControl | null) {
    this.write(`topup ${id}`, () => (this.customers.get(id)!.autoTopUp = control));
  }
  async previewMove() {
    return this.charge;
  }
  async move(id: string, planId: string, version: number) {
    const customer = this.customers.get(id)!;
    this.write(`move ${id} ${planId}`, () => {
      customer.plans.find((p) => p.planId === planId && p.kind === "subscription")!.version = version;
      customer.buckets = customer.buckets.map((b) => {
        if (b.planId !== planId) return b;
        const fresh = `ent_${++this.next}`;
        if (b.interval === "one_off") return { ...b, id: fresh, included: b.remaining, prepaid: 0, usage: 0 };
        const included = MONTHLY[planId]![version]!;
        return { ...b, id: fresh, included, remaining: included - b.usage };
      });
      this.total(customer);
    });
  }
  async setBucket(id: string, bucketId: string, values: { remaining: number; granted?: number }) {
    const customer = this.customers.get(id)!;
    this.write(`set ${id} ${bucketId}`, () => {
      const bucket = customer.buckets.find((b) => b.id === bucketId)!;
      bucket.remaining = values.remaining;
      if (values.granted !== undefined) bucket.included = values.granted;
      bucket.usage = bucket.included + bucket.prepaid - bucket.remaining;
      this.total(customer);
    });
  }
  private total(customer: CustomerState) {
    customer.total = customer.buckets.reduce((sum, b) => sum + b.remaining, 0);
  }
  add(id: string, state: Omit<CustomerState, "env" | "total">) {
    this.customers.set(id, { env: "sandbox", total: state.buckets.reduce((s, b) => s + b.remaining, 0), ...structuredClone(state) });
  }
}

class MemoryJournal implements SwitchJournal {
  readonly rows = new Map<string, JournalEntry & { error?: string; result?: unknown }>();
  async get(id: string) {
    const row = this.rows.get(id);
    return row && { step: row.step, record: structuredClone(row.record) };
  }
  async record(record: SwitchRecord) {
    if (!this.rows.has(record.customerId)) this.rows.set(record.customerId, { step: "recorded", record: structuredClone(record) });
    return (await this.get(record.customerId))!;
  }
  async advance(id: string, step: SwitchStep, result?: unknown) {
    Object.assign(this.rows.get(id)!, { step, result, error: undefined });
  }
  async fail(id: string, error: string) {
    this.rows.get(id)!.error = error;
  }
}

const bucket = (b: Partial<Bucket> & Pick<Bucket, "id" | "remaining">): Bucket => ({ planId: null, interval: "one_off", included: 0, prepaid: 0, usage: 0, resetsAt: null, expiresAt: null, ...b });
const quiet = () => {};

function fixtures() {
  const api = new FakeSwitchApi();
  // Standard with 25 prepaid (3 used), 10 more bought on their own, auto top-up on.
  api.add("acme-prepaid", {
    plans: [
      { planId: "standard", version: 1, kind: "subscription", status: "active" },
      { planId: "top_up", version: 2, kind: "purchase", status: "purchased" },
    ],
    buckets: [bucket({ id: "ent_std", planId: "standard", prepaid: 25, remaining: 22, usage: 3 }), bucket({ id: "ent_top", planId: "top_up", prepaid: 10, remaining: 10 })],
    autoTopUp: { enabled: true, threshold: 5, quantity: 10, purchaseLimit: { interval: "month", intervalCount: 1, limit: 5 } },
  });
  // A retired plan with 60 a month (7 used) and an empty pack bucket.
  api.add("acme-monthly", {
    plans: [{ planId: "lockbox", version: 1, kind: "subscription", status: "active" }],
    buckets: [bucket({ id: "ent_month", planId: "lockbox", interval: "month", included: 60, remaining: 53, usage: 7, resetsAt: Date.now() + 20 * 86_400_000 }), bucket({ id: "ent_pack", planId: "lockbox", remaining: 0 })],
    autoTopUp: null,
  });
  // Free credits: a standalone grant on the free plan, which keeps its version.
  api.add("acme-free", {
    plans: [{ planId: "trial", version: 1, kind: "subscription", status: "active" }],
    buckets: [bucket({ id: "free_credits", included: 20, remaining: 18, usage: 2 })],
    autoTopUp: { enabled: false, threshold: 0, quantity: 0, purchaseLimit: null },
  });
  return { api, journal: new MemoryJournal() };
}

const run = (api: SwitchApi, journal: SwitchJournal, id: string, dryRun = false) => switchCustomer(api, journal, id, { dryRun, log: quiet });

describe("switching a customer", () => {
  test("every bucket becomes 100 times what it was, plans move to their cent versions, and auto top-up is off until restored", async () => {
    const { api, journal } = fixtures();
    for (const id of ["acme-prepaid", "acme-monthly", "acme-free"]) expect(await run(api, journal, id)).toBe("verified");

    const prepaid = api.customers.get("acme-prepaid")!;
    expect(prepaid.plans.map((p) => [p.planId, p.version])).toEqual([["standard", 2], ["top_up", 2]]);
    expect(prepaid.buckets.map((b) => [b.planId, b.remaining, b.included + b.prepaid, b.usage])).toEqual([["standard", 2_200, 2_500, 300], ["top_up", 1_000, 1_000, 0]]);
    expect(prepaid.total).toBe(3_200);
    expect(prepaid.autoTopUp?.enabled).toBe(false);

    const monthly = api.customers.get("acme-monthly")!;
    expect(monthly.buckets.map((b) => [b.interval, b.included, b.remaining, b.usage, b.resetsAt !== null])).toEqual([["month", 6_000, 5_300, 700, true], ["one_off", 0, 0, 0, false]]);
    expect(api.customers.get("acme-free")!.buckets[0]).toMatchObject({ id: "free_credits", included: 2_000, remaining: 1_800, usage: 200 });
    // The free plan keeps its version: nothing to move.
    expect(api.writes.filter((w) => w.startsWith("move acme-free"))).toEqual([]);

    // A second full run changes nothing.
    const writes = api.writes.length;
    for (const id of ["acme-prepaid", "acme-monthly", "acme-free"]) expect(await run(api, journal, id)).toBe("verified");
    expect(api.writes.length).toBe(writes);

    // Then the top-ups, in cents: the catalog's line of 500, the recorded quantity times 100, the same monthly limit.
    expect(await restoreTopUp(api, journal, "acme-prepaid", { dryRun: false, log: quiet })).toBe("top_up_restored");
    expect(prepaid.autoTopUp).toEqual({ enabled: true, threshold: 500, quantity: 1_000, purchaseLimit: { interval: "month", intervalCount: 1, limit: 5 } });
    expect(await restoreTopUp(api, journal, "acme-free", { dryRun: false, log: quiet })).toBe("top_up_restored");
    expect(api.customers.get("acme-free")!.autoTopUp).toEqual({ enabled: false, threshold: 0, quantity: 0, purchaseLimit: null });
    expect(await restoreTopUp(api, journal, "acme-prepaid", { dryRun: false, log: quiet })).toBe("top_up_restored");
  });

  test("a run killed at any write, before or after it took effect, resumes to the same result, never granting twice", async () => {
    const expected = fixtures();
    await run(expected.api, expected.journal, "acme-prepaid");
    const final = expected.api.customers.get("acme-prepaid")!;
    const writes = expected.api.writes.length;
    for (let crash = 1; crash <= writes * 2; crash++) {
      const { api, journal } = fixtures();
      api.crashAt = ((crash - 1) % writes) + 1;
      api.crashAfter = crash > writes;
      await expect(run(api, journal, "acme-prepaid")).rejects.toThrow("killed");
      expect(await run(api, journal, "acme-prepaid")).toBe("verified");
      const after = api.customers.get("acme-prepaid")!;
      expect(after.total).toBe(final.total);
      expect(after.buckets.map((b) => [b.planId, b.remaining, b.included])).toEqual(final.buckets.map((b) => [b.planId, b.remaining, b.included]));
    }
  });

  test("a dry run reads only", async () => {
    const { api, journal } = fixtures();
    const lines: string[] = [];
    await switchCustomer(api, journal, "acme-prepaid", { dryRun: true, log: (_, line) => lines.push(line) });
    expect(api.writes).toEqual([]);
    expect(journal.rows.size).toBe(0);
    expect(lines.join("\n")).toContain("would move standard from version 1 to 2");
    expect(lines.join("\n")).toContain("remaining 22 -> 2200");
  });

  test("a balance that changed since it was recorded stops the run before anything is overwritten", async () => {
    const { api, journal } = fixtures();
    api.crashAt = 2; // Recorded and top-up off, then killed before the move.
    await expect(run(api, journal, "acme-prepaid")).rejects.toThrow("killed");
    // An auto top-up lands meanwhile.
    api.customers.get("acme-prepaid")!.buckets[1]!.remaining = 20;
    await expect(run(api, journal, "acme-prepaid")).rejects.toBeInstanceOf(SwitchStopped);
    expect(api.customers.get("acme-prepaid")!.plans[0]!.version).toBe(1);
    expect(journal.rows.get("acme-prepaid")!.error).toContain("changed since they were recorded");
  });

  test("a move that would charge anything is refused", async () => {
    const { api, journal } = fixtures();
    api.charge = 1;
    await expect(run(api, journal, "acme-prepaid")).rejects.toThrow("would charge 1");
    expect(api.writes.filter((w) => w.startsWith("move"))).toEqual([]);
  });

  test("a plan on an unknown version, a scheduled change or a reset due within the half hour is left for a person", async () => {
    const { api, journal } = fixtures();
    api.customers.get("acme-prepaid")!.plans[0]!.version = 7;
    await expect(run(api, journal, "acme-prepaid")).rejects.toThrow("neither the dollar");
    api.customers.get("acme-monthly")!.buckets[0]!.resetsAt = Date.now() + 60_000;
    await expect(run(api, journal, "acme-monthly")).rejects.toThrow("resets within 30 minutes");
    api.customers.get("acme-free")!.plans.push({ planId: "standard", version: 1, kind: "subscription", status: "scheduled" });
    await expect(run(api, journal, "acme-free")).rejects.toThrow("scheduled standard");
    expect(api.writes).toEqual([]);
  });

  test("undo puts a customer back exactly as recorded", async () => {
    const { api, journal } = fixtures();
    const before = structuredClone(api.customers.get("acme-prepaid")!);
    await run(api, journal, "acme-prepaid");
    expect(await undoCustomer(api, journal, "acme-prepaid", { dryRun: false, log: quiet })).toBe("undone");
    const after = api.customers.get("acme-prepaid")!;
    expect(after.plans).toEqual(before.plans);
    expect(after.total).toBe(before.total);
    expect(after.buckets.map((b) => [b.planId, b.remaining, b.included + b.prepaid])).toEqual(before.buckets.map((b) => [b.planId, b.remaining, b.included + b.prepaid]));
    expect(after.autoTopUp).toEqual(before.autoTopUp);
    await expect(run(api, journal, "acme-prepaid")).rejects.toThrow("was undone");
  });
});

test("a customer as Autumn returns it", () => {
  const state = customerState({
    id: "acme",
    env: "sandbox",
    subscriptions: [{ plan_id: "standard", status: "active", plan: { version: 1 } }],
    purchases: [{ plan_id: "top_up", plan: { version: 2 } }],
    balances: {
      credits: {
        remaining: 32,
        breakdown: [
          { id: "cus_ent_a", plan_id: "standard", included_grant: 0, prepaid_grant: 25, remaining: 22, usage: 3, reset: { interval: "one_off", resets_at: null }, expires_at: null },
          { id: "free_credits", plan_id: null, included_grant: 20, prepaid_grant: 0, remaining: 10, usage: 10, reset: null, expires_at: null },
        ],
      },
    },
    billing_controls: { auto_topups: [{ feature_id: "credits", enabled: true, threshold: 5, quantity: 10, purchase_limit: { interval: "month", interval_count: 1, limit: 5 } }] },
  });
  expect(state.plans).toEqual([
    { planId: "standard", version: 1, kind: "subscription", status: "active" },
    { planId: "top_up", version: 2, kind: "purchase", status: "purchased" },
  ]);
  expect(state.buckets[1]).toEqual({ id: "free_credits", planId: null, interval: "one_off", included: 20, prepaid: 0, remaining: 10, usage: 10, resetsAt: null, expiresAt: null });
  expect(state.autoTopUp).toEqual({ enabled: true, threshold: 5, quantity: 10, purchaseLimit: { interval: "month", intervalCount: 1, limit: 5 } });
});

test("a customer on a cent version that this switch never recorded is left alone", async () => {
  const { api, journal } = fixtures();
  api.customers.get("acme-prepaid")!.plans[0]!.version = 2;
  await expect(run(api, journal, "acme-prepaid")).rejects.toThrow("on the cent version already");
  api.customers.get("acme-monthly")!.plans.push({ planId: "top_up", version: 3, kind: "purchase", status: "purchased" });
  await expect(run(api, journal, "acme-monthly")).rejects.toThrow("top_up is on the cent version already");
  expect(api.writes).toEqual([]);
  expect(journal.rows.size).toBe(0);
});
