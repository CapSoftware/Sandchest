/**
 * An in-memory Autumn with the behaviour measured against the real sandbox:
 * a reservation holds credits under a lock id, retrying it is harmless,
 * finalizing twice is harmless, a confirm can charge less than was held, and
 * auto top-up buys more once usage drops the balance below its threshold.
 */
import { planById, PLANS, TOP_UP, type Autumn, type BillingState, type PlanId } from "@sandchest/billing";

interface FakeCustomer {
  planId: PlanId | null;
  credits: number;
  /** A card on file: purchases charge at once instead of returning a checkout URL. */
  card: boolean;
  locks: Map<string, number>;
  autoTopUp: { enabled: boolean; threshold: number; quantity: number; perMonth: number } | null;
  topUpsThisMonth: number;
  charges: Array<{ what: string; usd: number }>;
}

export class FakeAutumn implements Autumn {
  readonly customers = new Map<string, FakeCustomer>();
  readonly calls: string[] = [];
  /** Make the next call to a method fail, like an outage. */
  failNext = new Set<string>();

  /** Every new customer starts with this plan (null: none), as if it had bought it. */
  constructor(private readonly defaultPlan: PlanId | null = null) {}

  get(customerId: string): FakeCustomer {
    let customer = this.customers.get(customerId);
    if (!customer) {
      const plan = planById(this.defaultPlan);
      customer = { planId: plan?.id ?? null, credits: plan?.credits ?? 0, card: !!plan, locks: new Map(), autoTopUp: null, topUpsThisMonth: 0, charges: [] };
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
    customer.charges.push({ what: "auto_top_up", usd: (rule.quantity / TOP_UP.credits) * TOP_UP.price });
  }

  async customer(customerId: string): Promise<BillingState> {
    this.enter("customer");
    return this.state(this.get(customerId));
  }

  async reserve({ customerId, credits, lockId }: { customerId: string; credits: number; lockId: string; expiresAt: Date }) {
    this.enter("reserve");
    const customer = this.get(customerId);
    if (customer.locks.has(lockId)) return { allowed: true, remaining: null };
    if (!customer.planId && customer.credits === 0) return { allowed: false, remaining: null };
    if (customer.credits < credits) return { allowed: false, remaining: customer.credits };
    customer.credits -= credits;
    customer.locks.set(lockId, credits);
    this.afterUsage(customer);
    return { allowed: true, remaining: customer.credits };
  }

  async finalize({ customerId, lockId, action, credits }: { customerId: string; lockId: string; action: "confirm" | "release"; credits?: number }) {
    this.enter("finalize");
    const customer = this.get(customerId);
    const held = customer.locks.get(lockId);
    if (held === undefined) return;
    customer.locks.delete(lockId);
    customer.credits += action === "release" ? held : held - (credits ?? held);
  }

  async attach({ customerId, planId, packs }: { customerId: string; planId: PlanId | typeof TOP_UP.id; packs?: number; successUrl: string }) {
    this.enter("attach");
    const customer = this.get(customerId);
    if (!customer.card) {
      customer.card = true;
      this.settle(customer, planId, packs);
      return { paymentUrl: `https://checkout.test/${planId}` };
    }
    this.settle(customer, planId, packs);
    return { paymentUrl: null };
  }

  private settle(customer: FakeCustomer, planId: string, packs = 1): void {
    if (planId === TOP_UP.id) {
      customer.credits += packs * TOP_UP.credits;
      customer.charges.push({ what: "top_up", usd: packs * TOP_UP.price });
      return;
    }
    const plan = PLANS.find((p) => p.id === planId)!;
    customer.planId = plan.id;
    customer.credits += plan.credits;
    customer.charges.push({ what: plan.id, usd: plan.price });
  }

  async preview({ planId, packs }: { customerId: string; planId: PlanId | typeof TOP_UP.id; packs?: number }) {
    this.enter("preview");
    const plan = planById(planId);
    return { dueToday: plan ? plan.price : (packs ?? 1) * TOP_UP.price, nextCycle: plan ? plan.price : null, nextCycleAt: null };
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
