/**
 * The provider side of the one-time switch from a dollar credit to a cent credit: for one Autumn customer, every
 * credit balance becomes 100 times as many and the customer moves to the cent version of its plan. The operator
 * command (`apps/web/scripts/credit-unit-switch.ts`) runs it for every customer and holds the runbook.
 *
 * Each customer goes through these steps, each recorded in a journal before the next starts, so a run that dies
 * anywhere resumes where it stopped and a second full run changes nothing:
 *
 * 1. `recorded`: the customer's plans and versions, every credit balance bucket and its auto top-up, as read
 *    before anything changed. Written once and never overwritten: every later step works from it.
 * 2. `top_up_off`: auto top-up off, so none can fire at the old size while the balance is being changed.
 * 3. `moved`: each recurring plan on its dollar version moves to its cent version, with no proration and a
 *    prepaid quantity of 0. Measured in Autumn's sandbox (2026-11-10): the move keeps a one-off bucket's remaining
 *    number as it was (in a new bucket, under a new id), sets a monthly bucket to the new plan's allowance minus the
 *    usage so far, and grants any prepaid quantity sent with it on top: so 0 is sent. Before moving, the balances
 *    must still be exactly what was recorded, so a top-up or charge that landed since is never overwritten.
 *    A one-off purchase (credits bought on their own) cannot be moved: Autumn refuses price changes on one-off
 *    products. Its bucket stays where it is and is multiplied like any other.
 * 4. `multiplied`: every bucket is set to exactly 100 times its recorded remaining (`balances.update` with
 *    `remaining`, which sets the value outright, so repeating it is harmless). A bucket that never resets also gets
 *    100 times its recorded grant, so its usage reads as before; a monthly bucket's grant is its plan's, checked.
 *    Expiry and reset dates are never sent, so they never change.
 * 5. `verified`: Autumn reports exactly 100 times the recorded remaining in every bucket and in total, with expiry
 *    and reset dates unchanged and every plan on its cent version. Otherwise the run stops.
 * 6. `top_up_restored` (a separate run, after the app runs in cents): the recorded auto top-up again, buying 100
 *    times its recorded quantity once fewer than the cent catalog's line are left.
 *
 * `undo` takes a customer back to exactly what was recorded: its dollar versions, every bucket's recorded remaining
 * and grant, and its recorded auto top-up.
 */
import { CREDITS } from "./plans";
import { AUTUMN_VERSIONS, catalog, type CreditUnit } from "./units";

export const SWITCH_STEPS = ["recorded", "top_up_off", "moved", "multiplied", "verified", "top_up_restored"] as const;
export type SwitchStep = (typeof SWITCH_STEPS)[number] | "undone";

/** Credits per credit after the switch. */
export const FACTOR = 100;

/** How close a monthly reset may be before a customer is left for later: a reset mid-switch would refill it in the old unit. */
const RESET_MARGIN_MS = 30 * 60_000;

export interface Bucket {
  id: string;
  planId: string | null;
  /** `one_off`, or how often it resets. */
  interval: string;
  included: number;
  prepaid: number;
  remaining: number;
  usage: number;
  resetsAt: number | null;
  expiresAt: number | null;
}

export interface TopUpControl {
  enabled: boolean;
  threshold: number;
  quantity: number;
  purchaseLimit: { interval: string; intervalCount: number; limit: number } | null;
}

/** What a customer had before the switch touched it. */
export interface SwitchRecord {
  customerId: string;
  plans: Array<{ planId: string; version: number; kind: "subscription" | "purchase"; status: string }>;
  buckets: Bucket[];
  /** Remaining credits in all, as Autumn totals them. */
  total: number;
  autoTopUp: TopUpControl | null;
}

export interface JournalEntry {
  step: SwitchStep;
  record: SwitchRecord;
}

/** Where each customer's progress is kept: a row per customer, whose record is written once. */
export interface SwitchJournal {
  get(customerId: string): Promise<JournalEntry | undefined>;
  /** Stores the record unless one exists, and returns the stored entry either way. */
  record(record: SwitchRecord): Promise<JournalEntry>;
  advance(customerId: string, step: SwitchStep, result?: unknown): Promise<void>;
  fail(customerId: string, error: string): Promise<void>;
}

export class SwitchStopped extends Error {
  constructor(
    readonly customerId: string,
    message: string,
  ) {
    super(`${customerId}: ${message}`);
    this.name = "SwitchStopped";
  }
}

// ---- Autumn, as the switch calls it -------------------------------------------

interface RawBucket {
  id: string;
  plan_id: string | null;
  included_grant: number;
  prepaid_grant: number;
  remaining: number;
  usage: number;
  reset: { interval: string; resets_at: number | null } | null;
  expires_at: number | null;
}

interface RawCustomer {
  id: string;
  env?: string;
  subscriptions?: Array<{ plan_id: string; status: string; plan?: { version?: number } | null }>;
  purchases?: Array<{ plan_id: string; plan?: { version?: number } | null }>;
  balances?: Record<string, { remaining: number; breakdown?: RawBucket[] } | undefined>;
  billing_controls?: { auto_topups?: Array<{ feature_id: string; enabled: boolean; threshold: number; quantity: number; purchase_limit?: { interval: string; interval_count?: number; limit: number } | null }> };
}

export interface SwitchApi {
  /** `live` or `sandbox`, from the key's own prefix. */
  readonly environment: "live" | "sandbox";
  readonly baseUrl: string;
  customerIds(): Promise<string[]>;
  customer(customerId: string): Promise<CustomerState>;
  /** Version numbers by plan, for each unit's slugs. Throws if a version is missing (the cent catalog was not pushed). */
  versions(): Promise<Record<CreditUnit, Record<string, number>>>;
  setTopUp(customerId: string, control: TopUpControl | null): Promise<void>;
  /** What moving would charge now; a move is only made when this is 0. */
  previewMove(customerId: string, planId: string, version: number): Promise<number>;
  move(customerId: string, planId: string, version: number): Promise<void>;
  setBucket(customerId: string, bucketId: string, values: { remaining: number; granted?: number }): Promise<void>;
}

export interface CustomerState {
  env: string | undefined;
  plans: SwitchRecord["plans"];
  buckets: Bucket[];
  total: number;
  autoTopUp: TopUpControl | null;
}

/** The environment a key is for, or undefined when its prefix says neither. */
export function keyEnvironment(secretKey: string): "live" | "sandbox" | undefined {
  if (secretKey.startsWith("am_sk_live_")) return "live";
  if (secretKey.startsWith("am_sk_test_")) return "sandbox";
  return undefined;
}

export function createSwitchApi(config: { secretKey: string; baseUrl?: string; fetch?: typeof fetch }): SwitchApi {
  const environment = keyEnvironment(config.secretKey);
  if (!environment) throw new Error("The Autumn key is neither a live nor a sandbox secret key");
  const baseUrl = (config.baseUrl ?? "https://api.useautumn.com").replace(/\/$/, "");
  const doFetch = config.fetch ?? fetch;

  async function call<T>(path: string, body: unknown): Promise<T> {
    const response = await doFetch(`${baseUrl}/v1/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.secretKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await response.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) throw new Error(`Autumn ${path}: ${response.status} ${String(json.code ?? "")} ${String(json.message ?? response.statusText)}`.trim());
    return json as T;
  }

  return {
    environment,
    baseUrl,

    async customerIds() {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await call<{ list: Array<{ id: string }>; next_cursor?: string | null }>("customers.list", { limit: 500, ...(cursor ? { start_cursor: cursor } : {}) });
        ids.push(...page.list.map((c) => c.id));
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      return ids;
    },

    async customer(customerId) {
      return customerState(await call<RawCustomer>("customers.get", { customer_id: customerId, expand: ["subscriptions.plan", "purchases.plan"] }));
    },

    async versions() {
      const { list } = await call<{ list: Array<{ id: string; version: number; version_slug?: string }> }>("plans.list", { all_versions: true, include_archived: true });
      const resolve = (unit: CreditUnit) =>
        Object.fromEntries(
          Object.entries(AUTUMN_VERSIONS[unit]).map(([planId, slug]) => {
            const found = list.find((p) => p.id === planId && p.version_slug === slug);
            if (!found) throw new Error(`Autumn has no ${planId} ${slug} (the ${unit} catalog). Push it first.`);
            return [planId, found.version];
          }),
        );
      return { dollar: resolve("dollar"), cent: resolve("cent") };
    },

    async setTopUp(customerId, control) {
      const auto_topups = control
        ? [
            {
              feature_id: CREDITS,
              enabled: control.enabled,
              threshold: control.threshold,
              quantity: control.quantity,
              ...(control.purchaseLimit ? { purchase_limit: { interval: control.purchaseLimit.interval, interval_count: control.purchaseLimit.intervalCount, limit: control.purchaseLimit.limit } } : {}),
            },
          ]
        : [];
      await call("customers.update", { customer_id: customerId, billing_controls: { auto_topups } });
    },

    async previewMove(customerId, planId, version) {
      const preview = await call<{ total: number }>("billing.preview_update", { customer_id: customerId, plan_id: planId, version, proration_behavior: "none", feature_quantities: [{ feature_id: CREDITS, quantity: 0 }] });
      return preview.total;
    },

    async move(customerId, planId, version) {
      await call("billing.update", { customer_id: customerId, plan_id: planId, version, proration_behavior: "none", feature_quantities: [{ feature_id: CREDITS, quantity: 0 }], redirect_mode: "never" });
    },

    async setBucket(customerId, bucketId, values) {
      await call("balances.update", { customer_id: customerId, feature_id: CREDITS, balance_id: bucketId, remaining: values.remaining, ...(values.granted !== undefined ? { included_grant: values.granted } : {}) });
    },
  };
}

/** A customer as the switch reads it. Exposed for tests. */
export function customerState(raw: RawCustomer): CustomerState {
  const balance = raw.balances?.[CREDITS];
  const topUp = raw.billing_controls?.auto_topups?.find((c) => c.feature_id === CREDITS);
  return {
    env: raw.env,
    plans: [
      ...(raw.subscriptions ?? []).map((s) => ({ planId: s.plan_id, version: s.plan?.version ?? -1, kind: "subscription" as const, status: s.status })),
      ...(raw.purchases ?? []).map((p) => ({ planId: p.plan_id, version: p.plan?.version ?? -1, kind: "purchase" as const, status: "purchased" })),
    ],
    buckets: (balance?.breakdown ?? []).map((b) => ({
      id: b.id,
      planId: b.plan_id ?? null,
      interval: b.reset?.interval ?? "one_off",
      included: b.included_grant,
      prepaid: b.prepaid_grant,
      remaining: b.remaining,
      usage: b.usage,
      resetsAt: b.reset?.resets_at ?? null,
      expiresAt: b.expires_at ?? null,
    })),
    total: balance?.remaining ?? 0,
    autoTopUp: topUp
      ? {
          enabled: topUp.enabled,
          threshold: topUp.threshold,
          quantity: topUp.quantity,
          purchaseLimit: topUp.purchase_limit ? { interval: topUp.purchase_limit.interval, intervalCount: topUp.purchase_limit.interval_count ?? 1, limit: topUp.purchase_limit.limit } : null,
        }
      : null,
  };
}

// ---- The plan for one customer ---------------------------------------------------

const times = (n: number) => Math.round(n * FACTOR);
const resets = (bucket: Bucket) => bucket.interval !== "one_off";

/** The plans to move: each subscription on its dollar version, to its cent version. Throws on anything else unexpected. */
export function moves(record: SwitchRecord, versions: Record<CreditUnit, Record<string, number>>): Array<{ planId: string; from: number; to: number }> {
  const out: Array<{ planId: string; from: number; to: number }> = [];
  for (const plan of record.plans) {
    if (plan.kind === "purchase") continue;
    if (plan.status !== "active") throw new SwitchStopped(record.customerId, `a ${plan.status} ${plan.planId} subscription: decide it by hand first`);
    const from = versions.dollar[plan.planId];
    const to = versions.cent[plan.planId];
    if (from === undefined || to === undefined) throw new SwitchStopped(record.customerId, `${plan.planId} is not a Sandchest plan`);
    if (plan.version === to) continue;
    if (plan.version !== from) throw new SwitchStopped(record.customerId, `${plan.planId} is on version ${plan.version}, neither the dollar (${from}) nor the cent (${to}) one`);
    if (from !== to) out.push({ planId: plan.planId, from, to });
  }
  return out;
}

/**
 * Where each recorded bucket is after the moves, and what it must become. A bucket of a moved plan gets a new id,
 * so it is found by its plan and interval, which must name exactly one bucket before and after; any other bucket
 * keeps its id.
 */
export function bucketTargets(record: SwitchRecord, movedPlans: ReadonlySet<string>, current: Bucket[], to: "cent" | "dollar" = "cent") {
  const value = (n: number) => (to === "cent" ? times(n) : n);
  const claimed = new Set<string>();
  const targets = record.buckets.map((recorded) => {
    if (recorded.remaining < 0) throw new SwitchStopped(record.customerId, `bucket ${recorded.id} is negative`);
    const moved = recorded.planId !== null && movedPlans.has(recorded.planId);
    const same = (b: Bucket) => b.planId === recorded.planId && b.interval === recorded.interval;
    if (moved && record.buckets.filter(same).length !== 1) throw new SwitchStopped(record.customerId, `more than one ${recorded.planId} ${recorded.interval} bucket`);
    const matches = moved ? current.filter(same) : current.filter((b) => b.id === recorded.id);
    if (matches.length !== 1) throw new SwitchStopped(record.customerId, `bucket ${recorded.id} (${recorded.planId ?? "standalone"} ${recorded.interval}) is ${matches.length === 0 ? "missing" : "ambiguous"} now`);
    const now = matches[0]!;
    claimed.add(now.id);
    return {
      recorded,
      now,
      remaining: value(recorded.remaining),
      // A bucket that never resets keeps its usage as before; a resetting one's grant is its plan's.
      granted: resets(recorded) ? undefined : value(recorded.included + recorded.prepaid) - now.prepaid,
      expectedIncluded: resets(recorded) ? value(recorded.included) : undefined,
    };
  });
  const extra = current.filter((b) => !claimed.has(b.id));
  if (extra.length > 0) throw new SwitchStopped(record.customerId, `${extra.length} bucket(s) that were not recorded: ${extra.map((b) => b.id).join(", ")}`);
  return targets;
}

function topUpFor(record: SwitchRecord, unit: CreditUnit): TopUpControl | null {
  const recorded = record.autoTopUp;
  if (!recorded) return null;
  if (unit === "dollar") return recorded;
  // The cent catalog's line, unless the recorded one was the "off" placeholder of 0.
  return { ...recorded, threshold: recorded.threshold > 0 ? catalog("cent").topUpBelow : 0, quantity: times(recorded.quantity) };
}

/** Reads what a customer has now, for a record. */
export async function readRecord(api: SwitchApi, customerId: string): Promise<SwitchRecord> {
  const state = await api.customer(customerId);
  return { customerId, plans: state.plans, buckets: state.buckets, total: state.total, autoTopUp: state.autoTopUp };
}

function sameBuckets(a: Bucket[], b: Bucket[]): boolean {
  const key = (x: Bucket) => `${x.id}|${x.planId}|${x.interval}|${x.included}|${x.prepaid}|${x.remaining}|${x.resetsAt}|${x.expiresAt}`;
  return a.map(key).sort().join("\n") === b.map(key).sort().join("\n");
}

export interface StepLog {
  (customerId: string, message: string): void;
}

/**
 * Takes one customer through steps 1 to 5, from wherever its journal says it is. With `dryRun`, reads only and
 * says what each step would send. Throws `SwitchStopped` (recorded in the journal) when anything is not as expected.
 */
export async function switchCustomer(api: SwitchApi, journal: SwitchJournal, customerId: string, options: { dryRun: boolean; log: StepLog; now?: () => number }): Promise<SwitchStep> {
  const { dryRun, log } = options;
  const now = options.now ?? Date.now;
  const versions = await api.versions();
  let entry = await journal.get(customerId);
  if (entry && (entry.step === "verified" || entry.step === "top_up_restored")) {
    log(customerId, `already ${entry.step}`);
    return entry.step;
  }
  if (entry?.step === "undone") throw new SwitchStopped(customerId, "was undone: clear its journal row by hand before switching it again");
  try {
    // 1. Record.
    const record = entry?.record ?? (await readRecord(api, customerId));
    const soon = record.buckets.find((b) => resets(b) && b.resetsAt !== null && b.resetsAt - now() < RESET_MARGIN_MS);
    if (soon && !entry) throw new SwitchStopped(customerId, `a ${soon.interval} bucket resets within 30 minutes: run it again after the reset`);
    // On a cent version with no record of this switch moving it: its credits may be cents already.
    const cent = record.plans.find((p) => versions.dollar[p.planId] !== versions.cent[p.planId] && p.version === versions.cent[p.planId]);
    if (cent && !entry) throw new SwitchStopped(customerId, `its ${cent.planId} is on the cent version already, and this switch has no record of moving it`);
    const planned = moves(record, versions);
    if (dryRun) {
      describe(record, planned, versions, log);
      return entry?.step ?? "recorded";
    }
    if (!entry) {
      entry = await journal.record(record);
      log(customerId, "recorded");
    }
    const at = (step: SwitchStep) => SWITCH_STEPS.indexOf(entry!.step as (typeof SWITCH_STEPS)[number]) >= SWITCH_STEPS.indexOf(step as (typeof SWITCH_STEPS)[number]);

    // 2. Auto top-up off.
    if (!at("top_up_off")) {
      if (record.autoTopUp?.enabled) await api.setTopUp(customerId, { ...record.autoTopUp, enabled: false });
      await journal.advance(customerId, "top_up_off");
      entry = { ...entry, step: "top_up_off" };
      log(customerId, record.autoTopUp?.enabled ? "auto top-up off" : "no auto top-up to turn off");
    }

    // 3. Move each plan to its cent version, only from exactly the recorded balances, and only for nothing.
    if (!at("moved")) {
      const state = await api.customer(customerId);
      for (const move of planned) {
        const version = state.plans.find((p) => p.kind === "subscription" && p.planId === move.planId)?.version;
        if (version === move.to) continue;
        if (!sameBuckets(state.buckets, record.buckets)) throw new SwitchStopped(customerId, "its balances changed since they were recorded");
        const due = await api.previewMove(customerId, move.planId, move.to);
        if (due !== 0) throw new SwitchStopped(customerId, `moving ${move.planId} would charge ${due}`);
        await api.move(customerId, move.planId, move.to);
        log(customerId, `${move.planId} moved from version ${move.from} to ${move.to}`);
      }
      await journal.advance(customerId, "moved");
      entry = { ...entry, step: "moved" };
    }

    // 4. Every bucket to 100 times what was recorded.
    if (!at("multiplied")) {
      const state = await api.customer(customerId);
      const movedPlans = new Set(planned.map((m) => m.planId));
      const movedPlan = (b: Bucket) => b.planId !== null && movedPlans.has(b.planId);
      const targets = bucketTargets(record, movedPlans, state.buckets);
      for (const target of targets) {
        if (target.expectedIncluded !== undefined && target.now.included !== target.expectedIncluded) {
          throw new SwitchStopped(customerId, `the ${target.recorded.planId} ${target.recorded.interval} allowance is ${target.now.included}, not ${target.expectedIncluded}`);
        }
        if (target.granted !== undefined && target.granted < 0) throw new SwitchStopped(customerId, `bucket ${target.now.id} would need a negative grant`);
        if (target.now.remaining === target.remaining && (target.granted === undefined || target.now.included === target.granted)) continue;
        // Only from what the move left (or what was recorded): anything else came in since, and is never overwritten.
        const before = target.expectedIncluded !== undefined && movedPlan(target.recorded) ? target.expectedIncluded - target.recorded.usage : target.recorded.remaining;
        if (target.now.remaining !== before) throw new SwitchStopped(customerId, `bucket ${target.now.id} has ${target.now.remaining}, neither ${before} as recorded nor ${target.remaining}`);
        await api.setBucket(customerId, target.now.id, { remaining: target.remaining, ...(target.granted !== undefined ? { granted: target.granted } : {}) });
        log(customerId, `bucket ${target.now.id}: ${target.recorded.remaining} -> ${target.remaining}`);
      }
      await journal.advance(customerId, "multiplied");
      entry = { ...entry, step: "multiplied" };
    }

    // 5. Verify.
    const state = await api.customer(customerId);
    const result = verify(record, planned, versions.cent, state);
    await journal.advance(customerId, "verified", result);
    log(customerId, `verified: ${record.total} -> ${state.total}`);
    return "verified";
  } catch (error) {
    if (!dryRun && entry) await journal.fail(customerId, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

function verify(record: SwitchRecord, planned: Array<{ planId: string }>, cent: Record<string, number>, state: CustomerState) {
  const problems: string[] = [];
  for (const plan of state.plans) {
    if (plan.kind === "subscription" && plan.status === "active" && cent[plan.planId] !== undefined && plan.version !== cent[plan.planId]) problems.push(`${plan.planId} is on version ${plan.version}`);
  }
  const targets = bucketTargets(record, new Set(planned.map((m) => m.planId)), state.buckets);
  for (const t of targets) {
    if (t.now.remaining !== t.remaining) problems.push(`bucket ${t.now.id} has ${t.now.remaining}, not ${t.remaining}`);
    if (t.now.expiresAt !== t.recorded.expiresAt) problems.push(`bucket ${t.now.id} expiry changed`);
    if (t.now.resetsAt !== t.recorded.resetsAt) problems.push(`bucket ${t.now.id} reset date changed`);
  }
  if (state.total !== times(record.total)) problems.push(`total is ${state.total}, not ${times(record.total)}`);
  if (problems.length > 0) throw new SwitchStopped(record.customerId, `not verified: ${problems.join("; ")}`);
  return { total: state.total, buckets: targets.map((t) => ({ id: t.now.id, remaining: t.now.remaining })) };
}

function describe(record: SwitchRecord, planned: Array<{ planId: string; from: number; to: number }>, versions: Record<CreditUnit, Record<string, number>>, log: StepLog) {
  const id = record.customerId;
  const plans = record.plans.map((p) => `${p.planId} v${p.version} (${p.kind}${p.kind === "subscription" ? `, ${p.status}` : ""})`).join(", ") || "none";
  log(id, `plans: ${plans}; ${record.total} credits in all`);
  if (record.autoTopUp?.enabled) log(id, `would turn auto top-up off (below ${record.autoTopUp.threshold}, buy ${record.autoTopUp.quantity})`);
  for (const move of planned) log(id, `would move ${move.planId} from version ${move.from} to ${move.to}, prepaid quantity 0, no proration`);
  for (const purchase of record.plans.filter((p) => p.kind === "purchase")) {
    if (purchase.version !== versions.cent[purchase.planId]) log(id, `keeps its ${purchase.planId} purchase on version ${purchase.version} (one-off purchases cannot move)`);
  }
  for (const bucket of record.buckets) {
    const grant = resets(bucket) ? `allowance must read ${times(bucket.included)}` : `grant ${bucket.included + bucket.prepaid} -> ${times(bucket.included + bucket.prepaid)}`;
    log(id, `would set ${bucket.planId ?? "standalone"} ${bucket.interval} bucket ${bucket.id}: remaining ${bucket.remaining} -> ${times(bucket.remaining)}, ${grant}`);
  }
  const topUp = topUpFor(record, "cent");
  if (topUp?.enabled) log(id, `top-ups run later: below ${topUp.threshold}, buy ${topUp.quantity}${topUp.purchaseLimit ? `, at most ${topUp.purchaseLimit.limit} a ${topUp.purchaseLimit.interval}` : ""}`);
}

/** Step 6: the recorded auto top-up again, in cents. Only for a verified customer. */
export async function restoreTopUp(api: SwitchApi, journal: SwitchJournal, customerId: string, options: { dryRun: boolean; log: StepLog }): Promise<SwitchStep> {
  const entry = await journal.get(customerId);
  if (!entry) throw new SwitchStopped(customerId, "has no journal row: switch it first");
  if (entry.step === "top_up_restored") {
    options.log(customerId, "auto top-up already restored");
    return entry.step;
  }
  if (entry.step !== "verified") throw new SwitchStopped(customerId, `is at ${entry.step}, not verified`);
  const control = topUpFor(entry.record, "cent");
  if (options.dryRun) {
    options.log(customerId, control?.enabled ? `would set auto top-up: below ${control.threshold}, buy ${control.quantity}` : "no auto top-up to restore");
    return entry.step;
  }
  if (control?.enabled) await api.setTopUp(customerId, control);
  await journal.advance(customerId, "top_up_restored");
  options.log(customerId, control?.enabled ? `auto top-up on: below ${control.threshold}, buy ${control.quantity}` : "no auto top-up to restore");
  return "top_up_restored";
}

/**
 * Puts a customer back to exactly what was recorded: its dollar versions, every bucket's recorded remaining and
 * grant, and its recorded auto top-up. For a switch that failed midway, before the app runs in cents.
 */
export async function undoCustomer(api: SwitchApi, journal: SwitchJournal, customerId: string, options: { dryRun: boolean; log: StepLog }): Promise<SwitchStep> {
  const entry = await journal.get(customerId);
  if (!entry) throw new SwitchStopped(customerId, "has no journal row: nothing was changed");
  if (entry.step === "undone") return entry.step;
  const { record } = entry;
  const versions = await api.versions();
  const back = record.plans.filter((p) => p.kind === "subscription" && versions.dollar[p.planId] !== undefined && versions.dollar[p.planId] !== versions.cent[p.planId]);
  if (options.dryRun) {
    options.log(customerId, `would move ${back.map((p) => p.planId).join(", ") || "nothing"} back, set every bucket to its recorded value and restore auto top-up`);
    return entry.step;
  }
  let state = await api.customer(customerId);
  for (const plan of back) {
    const version = state.plans.find((p) => p.kind === "subscription" && p.planId === plan.planId)?.version;
    if (version === plan.version) continue;
    const due = await api.previewMove(customerId, plan.planId, plan.version);
    if (due !== 0) throw new SwitchStopped(customerId, `moving ${plan.planId} back would charge ${due}`);
    await api.move(customerId, plan.planId, plan.version);
    options.log(customerId, `${plan.planId} moved back to version ${plan.version}`);
  }
  state = await api.customer(customerId);
  for (const target of bucketTargets(record, new Set(back.map((p) => p.planId)), state.buckets, "dollar")) {
    if (target.now.remaining === target.remaining && (target.granted === undefined || target.now.included === target.granted)) continue;
    await api.setBucket(customerId, target.now.id, { remaining: target.remaining, ...(target.granted !== undefined ? { granted: target.granted } : {}) });
  }
  if (record.autoTopUp) await api.setTopUp(customerId, record.autoTopUp);
  await journal.advance(customerId, "undone");
  options.log(customerId, "undone");
  return "undone";
}
