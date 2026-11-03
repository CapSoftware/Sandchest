/**
 * An in-memory Autumn with the behaviour measured against the real sandbox:
 * a reservation holds credits under a lock id, retrying it is harmless,
 * finalizing twice is harmless, a confirm can charge less than was held,
 * auto top-up buys more once usage drops the balance below its threshold, and
 * a purchase sent again under the same idempotency key charges nothing more.
 */
import { AutumnError, creditsPrice, planById, PLANS, TOP_UP, type Autumn, type BillingState, type PlanId } from "@sandchest/billing";

interface FakeCustomer {
  planId: PlanId | null;
  credits: number;
  /** A card on file: purchases charge at once instead of returning a checkout URL. */
  card: boolean;
  locks: Map<string, number>;
  autoTopUp: { enabled: boolean; threshold: number; quantity: number; perMonth: number } | null;
  topUpsThisMonth: number;
  charges: Array<{ what: string; usd: number }>;
  /** Balance ids granted (free credits), so a second grant under one does nothing. */
  grants: Set<string>;
}

export class FakeAutumn implements Autumn {
  readonly customers = new Map<string, FakeCustomer>();
  readonly calls: string[] = [];
  /** Make the next call to a method fail, like an outage. */
  failNext = new Set<string>();
  /** How long reads and reservations take, so concurrent calls overlap the way real ones do. */
  latencyMs = 0;
  /** Every idempotency key a purchase was sent with, in order, repeats included. */
  readonly attachKeys: string[] = [];
  private readonly seenKeys = new Set<string>();
  /** Make the next purchase charge, then fail anyway, like a timeout after the charge went through. */
  loseNextAnswer = false;

  /** Every new customer starts with this plan (null: none), as if it had bought it. */
  constructor(private readonly defaultPlan: PlanId | null = null) {}

  get(customerId: string): FakeCustomer {
    let customer = this.customers.get(customerId);
    if (!customer) {
      const plan = planById(this.defaultPlan);
      customer = { planId: plan?.id ?? null, credits: plan?.credits ?? 0, card: !!plan && plan.price > 0, locks: new Map(), autoTopUp: null, topUpsThisMonth: 0, charges: [], grants: new Set() };
      this.customers.set(customerId, customer);
    }
    return customer;
  }

  private enter(method: string): void {
    this.calls.push(method);
    if (this.failNext.delete(method)) throw new Error(`fake ${method} outage`);
  }

  private state(customer: FakeCustomer): BillingState {
    return {
      planId: customer.planId,
      pastDue: false,
      endsAt: null,
      renewsAt: customer.planId ? new Date("2030-01-01T00:00:00Z") : null,
      nextPlanId: null,
      credits: { remaining: customer.credits, resetsAt: customer.planId ? new Date("2030-01-01T00:00:00Z") : null },
      autoTopUp: customer.autoTopUp,
    };
  }

  private afterUsage(customer: FakeCustomer): void {
    const rule = customer.autoTopUp;
    if (!rule?.enabled || !customer.planId || customer.credits >= rule.threshold || customer.topUpsThisMonth >= rule.perMonth) return;
    customer.credits += rule.quantity;
    customer.topUpsThisMonth++;
    const pack = planById(customer.planId)!.pack;
    customer.charges.push({ what: "auto_top_up", usd: (rule.quantity / pack.credits) * pack.price });
  }

  async customer(customerId: string): Promise<BillingState> {
    this.enter("customer");
    if (this.latencyMs) await Bun.sleep(this.latencyMs);
    return this.state(this.get(customerId));
  }

  async stripeCustomer(customerId: string): Promise<string> {
    this.get(customerId);
    return `cus_${customerId.replace(/-/g, "").slice(0, 14)}`;
  }

  async reserve({ customerId, credits, lockId }: { customerId: string; credits: number; lockId: string; expiresAt: Date }) {
    this.enter("reserve");
    if (this.latencyMs) await Bun.sleep(this.latencyMs);
    const customer = this.get(customerId);
    if (customer.locks.has(lockId)) return { allowed: true, remaining: null };
    if (!customer.planId && customer.credits === 0) return { allowed: false, remaining: null };
    if (customer.credits < credits) return { allowed: false, remaining: customer.credits };
    customer.credits -= credits;
    customer.locks.set(lockId, credits);
    this.afterUsage(customer);
    return { allowed: true, remaining: customer.credits };
  }

  async check(customerId: string, credits: number) {
    this.enter("check");
    const customer = this.customers.get(customerId);
    if (!customer) return { allowed: false, remaining: null };
    return { allowed: customer.credits >= credits, remaining: customer.credits };
  }

  async grant({ customerId, credits, balanceId }: { customerId: string; credits: number; balanceId: string }) {
    this.enter("grant");
    const customer = this.get(customerId);
    if (customer.grants.has(balanceId)) return;
    customer.grants.add(balanceId);
    customer.credits += credits;
  }

  async finalize({ customerId, lockId, action, credits }: { customerId: string; lockId: string; action: "confirm" | "release"; credits?: number }) {
    this.enter("finalize");
    const customer = this.get(customerId);
    const held = customer.locks.get(lockId);
    if (held === undefined) return;
    customer.locks.delete(lockId);
    customer.credits += action === "release" ? held : held - (credits ?? held);
  }

  async attach({ customerId, planId, credits, idempotencyKey }: { customerId: string; planId: PlanId | typeof TOP_UP.id; credits?: number; successUrl: string; idempotencyKey?: string }) {
    this.enter("attach");
    if (idempotencyKey) {
      this.attachKeys.push(idempotencyKey);
      if (this.seenKeys.has(idempotencyKey)) return { paymentUrl: null, repeated: true as const };
      this.seenKeys.add(idempotencyKey);
    }
    const result = this.charge(customerId, planId, credits);
    if (this.loseNextAnswer) {
      this.loseNextAnswer = false;
      throw new AutumnError("Autumn billing.attach: The operation timed out.", 0, "network");
    }
    return result;
  }

  private charge(customerId: string, planId: PlanId | typeof TOP_UP.id, credits?: number) {
    const customer = this.get(customerId);
    if (customer.planId === planId) throw new AutumnError("Cannot attach because the customer's current product is the same as the product being attached", 409, "plan_already_attached");
    // A free plan never asks for a card.
    if (planById(planId)?.price === 0) {
      this.settle(customer, planId, credits);
      return { paymentUrl: null };
    }
    if (!customer.card) {
      customer.card = true;
      this.settle(customer, planId, credits);
      return { paymentUrl: `https://checkout.test/${planId}` };
    }
    this.settle(customer, planId, credits);
    return { paymentUrl: null };
  }

  private settle(customer: FakeCustomer, planId: string, credits?: number): void {
    if (planId === TOP_UP.id) {
      const bought = credits ?? 1;
      customer.credits += bought;
      customer.charges.push({ what: "top_up", usd: creditsPrice(bought) });
      return;
    }
    const plan = PLANS.find((p) => p.id === planId)!;
    customer.planId = plan.id;
    customer.credits += plan.credits + (credits ?? 0);
    customer.charges.push({ what: plan.id, usd: plan.price + creditsPrice(credits ?? 0) });
  }

  async preview({ planId, credits }: { customerId: string; planId: PlanId | typeof TOP_UP.id; credits?: number }) {
    this.enter("preview");
    const plan = planById(planId);
    const bought = creditsPrice(credits ?? (plan ? 0 : 1));
    return { dueToday: (plan?.price ?? 0) + bought, discount: 0, nextCycle: plan ? plan.price : null, nextCycleAt: null };
  }

  async portal(customerId: string) {
    this.enter("portal");
    return `https://billing.test/${customerId}`;
  }

  async setAutoTopUp(customerId: string, control: { enabled: boolean; threshold: number; quantity: number; perMonth: number }) {
    this.enter("setAutoTopUp");
    this.get(customerId).autoTopUp = control;
  }
}
