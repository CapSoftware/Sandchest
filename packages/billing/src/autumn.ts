/**
 * A small client for the parts of Autumn's API Sandchest uses. Autumn's own
 * SDK is several megabytes; these calls are a handful of JSON posts.
 *
 * Calls that only read, or that Autumn makes idempotent by id (customers,
 * locks), are retried on network errors and 5xx/429. Calls that can charge a
 * card are never retried: a timeout there may still have charged.
 */
import { CREDITS, planById, PLANS, TOP_UP, type PlanId } from "./plans";

export interface AutumnConfig {
  secretKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request timeout. Default 10 s; charges get 45 s. */
  timeoutMs?: number;
}

export class AutumnError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "AutumnError";
  }
}

/** What Sandchest needs to know about an org's billing, read from its Autumn customer. */
export interface BillingState {
  /** The org's plan, while it is active (including past due and cancelling). */
  planId: PlanId | null;
  pastDue: boolean;
  /** Set when the plan was cancelled and ends at the close of the period. */
  endsAt: Date | null;
  renewsAt: Date | null;
  /** A plan that takes over at the end of this period (a downgrade). */
  nextPlanId: PlanId | null;
  credits: { remaining: number; resetsAt: Date | null };
  autoTopUp: { enabled: boolean; threshold: number; quantity: number; perMonth: number } | null;
}

export interface Reservation {
  allowed: boolean;
  /** Credits left after the reservation, or before it when refused. Null when the org has no balance at all. */
  remaining: number | null;
}

export interface AttachResult {
  /** Where to send the person to pay (Stripe Checkout or a 3-D Secure step). Null when it was charged already. */
  paymentUrl: string | null;
}

export interface ChargePreview {
  /** USD due now. */
  dueToday: number;
  /** USD a promotion code takes off what's due now. */
  discount: number;
  /** USD on the next regular invoice, if the change recurs. */
  nextCycle: number | null;
  nextCycleAt: Date | null;
}

export interface Autumn {
  /** Creates the customer if needed and returns its billing state. */
  customer(customerId: string, name?: string): Promise<BillingState>;
  /** The customer's Stripe customer id, creating the customer (in Autumn and in Stripe) if needed. */
  stripeCustomer(customerId: string, name?: string): Promise<string>;
  /** Holds `credits` until `finalize`, or until `expiresAt`, when they return on their own. */
  reserve(input: { customerId: string; credits: number; lockId: string; expiresAt: Date }): Promise<Reservation>;
  /** Whether the customer has `credits` to spend, holding none of them. */
  check(customerId: string, credits: number): Promise<Reservation>;
  /**
   * Gives the customer `credits` for free, once: a balance of its own under
   * `balanceId` that never resets or expires, and outlives any plan change.
   * Granting under the same id again does nothing.
   */
  grant(input: { customerId: string; credits: number; balanceId: string }): Promise<void>;
  /** Charges a reservation (optionally fewer credits), or gives it back. Finalizing twice is harmless. */
  finalize(input: { customerId: string; lockId: string; action: "confirm" | "release"; credits?: number }): Promise<void>;
  /**
   * Subscribes to a plan, or buys credits on their own (`top_up`). `credits`
   * buys that many credits with it. Charges a saved card at once, otherwise
   * returns a checkout URL.
   */
  attach(input: { customerId: string; planId: PlanId | typeof TOP_UP.id; credits?: number; promotionCode?: string; successUrl: string }): Promise<AttachResult>;
  /** What attaching would charge, with a promotion code's discount if one is given. */
  preview(input: { customerId: string; planId: PlanId | typeof TOP_UP.id; credits?: number; promotionCode?: string }): Promise<ChargePreview>;
  /** A Stripe billing portal session: card, invoices, cancellation. */
  portal(customerId: string, returnUrl: string): Promise<string>;
  setAutoTopUp(customerId: string, control: { enabled: boolean; threshold: number; quantity: number; perMonth: number }): Promise<void>;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export function createAutumn(config: AutumnConfig): Autumn {
  const base = (config.baseUrl ?? "https://api.useautumn.com").replace(/\/$/, "");
  const doFetch = config.fetch ?? fetch;

  async function call<T>(path: string, body: unknown, options: { retry: boolean; timeoutMs?: number }): Promise<T> {
    const attempts = options.retry ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await doFetch(`${base}/v1/${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${config.secretKey}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs ?? config.timeoutMs ?? 10_000),
        });
        const text = await response.text();
        const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        if (response.ok) return json as T;
        const error = new AutumnError(`Autumn ${path}: ${String(json.message ?? response.statusText)}`, response.status, typeof json.code === "string" ? json.code : undefined);
        if (attempt >= attempts || !RETRYABLE.has(response.status)) throw error;
      } catch (error) {
        if (error instanceof AutumnError && !RETRYABLE.has(error.status)) throw error;
        if (attempt >= attempts) throw error instanceof AutumnError ? error : new AutumnError(`Autumn ${path}: ${error instanceof Error ? error.message : String(error)}`, 0, "network");
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * 3 ** (attempt - 1)));
    }
  }

  // A promotion code as Autumn takes it: Stripe's customer-facing codes, not coupon or reward IDs.
  const discounts = (code: string | undefined) => (code ? { discounts: [{ promotion_code: code }] } : {});

  // Credits on their own always buy at least one; with a plan, none unless asked.
  const quantities = (planId: string, credits: number | undefined) => {
    const quantity = planId === TOP_UP.id ? Math.max(1, credits ?? 1) : (credits ?? 0);
    return quantity > 0 ? [{ feature_id: CREDITS, quantity }] : undefined;
  };

  return {
    async customer(customerId, name) {
      const raw = await call<RawCustomer>("customers.get_or_create", { customer_id: customerId, ...(name ? { name } : {}) }, { retry: true });
      return billingState(raw);
    },

    async stripeCustomer(customerId, name) {
      const raw = await call<{ stripe_id?: string | null; processors?: { stripe?: { id?: string | null } } }>(
        "customers.get_or_create",
        { customer_id: customerId, create_in_stripe: true, ...(name ? { name } : {}) },
        { retry: true },
      );
      const id = raw.stripe_id ?? raw.processors?.stripe?.id;
      if (!id) throw new AutumnError("Autumn customers.get_or_create: no Stripe customer", 502, "no_stripe_customer");
      return id;
    },

    async reserve({ customerId, credits, lockId, expiresAt }) {
      try {
        const raw = await call<{ allowed: boolean; balance: { remaining: number } | null }>(
          "check",
          { customer_id: customerId, feature_id: CREDITS, required_balance: credits, send_event: true, lock: { enabled: true, lock_id: lockId, expires_at: expiresAt.getTime() } },
          { retry: true },
        );
        return { allowed: raw.allowed, remaining: raw.balance?.remaining ?? null };
      } catch (error) {
        // A retry of a reservation that went through.
        if (error instanceof AutumnError && error.code === "lock_already_exists") return { allowed: true, remaining: null };
        // An org that has never been a customer has no plan and no credits.
        if (error instanceof AutumnError && error.code === "customer_not_found") return { allowed: false, remaining: null };
        throw error;
      }
    },

    async check(customerId, credits) {
      try {
        const raw = await call<{ allowed: boolean; balance: { remaining: number } | null }>(
          "check",
          { customer_id: customerId, feature_id: CREDITS, required_balance: credits },
          { retry: true },
        );
        return { allowed: raw.allowed, remaining: raw.balance?.remaining ?? null };
      } catch (error) {
        if (error instanceof AutumnError && error.code === "customer_not_found") return { allowed: false, remaining: null };
        throw error;
      }
    },

    async grant({ customerId, credits, balanceId }) {
      try {
        await call("balances.create", { customer_id: customerId, feature_id: CREDITS, included_grant: credits, balance_id: balanceId }, { retry: true });
      } catch (error) {
        // Granted already: by an earlier claim, or by this one's retry after a lost answer.
        if (error instanceof AutumnError && error.status === 409 && /already in use/i.test(error.message)) return;
        throw error;
      }
    },

    async finalize({ customerId, lockId, action, credits }) {
      try {
        await call("balances.finalize", { customer_id: customerId, lock_id: lockId, action, ...(credits !== undefined ? { override_value: credits } : {}) }, { retry: true });
      } catch (error) {
        // Already finalized (a retried step), expired (released on its own), or never held.
        if (error instanceof AutumnError && ((error.status === 400 && /lock not found/i.test(error.message)) || error.code === "customer_not_found")) return;
        throw error;
      }
    },

    async attach({ customerId, planId, credits, promotionCode, successUrl }) {
      const raw = await call<{ payment_url: string | null }>(
        "billing.attach",
        {
          customer_id: customerId,
          plan_id: planId,
          feature_quantities: quantities(planId, credits),
          ...discounts(promotionCode),
          redirect_mode: "if_required",
          success_url: successUrl,
        },
        { retry: false, timeoutMs: 45_000 },
      );
      return { paymentUrl: raw.payment_url ?? null };
    },

    async preview({ customerId, planId, credits, promotionCode }) {
      const raw = await call<{
        total: number;
        subtotal?: number;
        line_items?: Array<{ discounts?: Array<{ amount_off: number }> }>;
        next_cycle?: { total: number; starts_at: number } | null;
      }>(
        "billing.preview_attach",
        { customer_id: customerId, plan_id: planId, feature_quantities: quantities(planId, credits), ...discounts(promotionCode), redirect_mode: "if_required" },
        { retry: true },
      );
      // The lines' own discounts, or (if Autumn doesn't list them) what the total is short of the subtotal.
      const listed = (raw.line_items ?? []).flatMap((line) => line.discounts ?? []).reduce((sum, d) => sum + d.amount_off, 0);
      const discount = listed || Math.max(0, (raw.subtotal ?? raw.total) - raw.total);
      return { dueToday: raw.total, discount, nextCycle: raw.next_cycle?.total ?? null, nextCycleAt: raw.next_cycle ? new Date(raw.next_cycle.starts_at) : null };
    },

    async portal(customerId, returnUrl) {
      return (await call<{ url: string }>("billing.open_customer_portal", { customer_id: customerId, return_url: returnUrl }, { retry: true })).url;
    },

    async setAutoTopUp(customerId, control) {
      await call(
        "customers.update",
        {
          customer_id: customerId,
          billing_controls: {
            auto_topups: [
              {
                feature_id: CREDITS,
                enabled: control.enabled,
                threshold: control.threshold,
                quantity: control.quantity,
                purchase_limit: { interval: "month", interval_count: 1, limit: Math.max(1, control.perMonth) },
              },
            ],
          },
        },
        { retry: true },
      );
    },
  };
}

// ---- Customer → billing state ------------------------------------------

interface RawCustomer {
  subscriptions?: Array<{ plan_id: string; status: string; past_due?: boolean; canceled_at: number | null; expires_at: number | null; current_period_end: number | null; started_at: number }>;
  balances?: Record<string, { remaining: number; next_reset_at: number | null } | undefined>;
  billing_controls?: { auto_topups?: Array<{ feature_id: string; enabled: boolean; threshold: number; quantity: number; purchase_limit?: { limit: number } }> };
}

const PLAN_IDS = new Set<string>(PLANS.map((p) => p.id));
const date = (ms: number | null | undefined) => (ms ? new Date(ms) : null);

/** Reads an Autumn customer. Exposed for tests. */
export function billingState(raw: RawCustomer): BillingState {
  const subscriptions = (raw.subscriptions ?? []).filter((s) => PLAN_IDS.has(s.plan_id));
  const active = subscriptions.find((s) => s.status === "active");
  const scheduled = subscriptions.find((s) => s.status === "scheduled" && s.plan_id !== active?.plan_id);
  const balance = raw.balances?.[CREDITS];
  const topUp = raw.billing_controls?.auto_topups?.find((c) => c.feature_id === CREDITS);
  const cancelling = !!active && (active.canceled_at !== null || active.expires_at !== null);
  return {
    planId: (planById(active?.plan_id)?.id ?? null) as PlanId | null,
    pastDue: !!active?.past_due,
    endsAt: cancelling ? date(active!.expires_at ?? active!.current_period_end) : null,
    renewsAt: active && !cancelling ? date(active.current_period_end) : null,
    nextPlanId: (planById(scheduled?.plan_id)?.id ?? null) as PlanId | null,
    credits: { remaining: Math.max(0, Math.floor(balance?.remaining ?? 0)), resetsAt: date(balance?.next_reset_at) },
    autoTopUp: topUp ? { enabled: topUp.enabled, threshold: topUp.threshold, quantity: topUp.quantity, perMonth: topUp.purchase_limit?.limit ?? 0 } : null,
  };
}
