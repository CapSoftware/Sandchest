/**
 * Autumn's webhooks (delivered by Svix): the route verifies the signature,
 * then this reads the event. Svix retries a delivery until it gets a 2xx, and
 * may deliver one twice, so every effect is idempotent: emails are reserved
 * by a stable key (the top-up's invoice), and state is only ever re-read from
 * Autumn, never taken from a payload that may be long out of date.
 *
 * - `billing.auto_topup_succeeded`: email the admins once per invoice, and
 *   (first delivery only) re-read the org, which re-arms the credit emails.
 * - `billing.auto_topup_failed`: email them when there is something to do
 *   (the card, or the monthly limit), at most once a day per reason.
 * - `billing.updated`: re-read the org, so a plan bought in Checkout starts
 *   recon even if nobody returns to the dashboard.
 *
 * Unknown events, other features and unknown customers are acknowledged and
 * ignored, so Autumn does not retry them.
 */
import { CREDITS } from "@sandchest/billing/plans";
import { staleOrgBilling } from "@sandchest/db";
import { recordLater } from "./analytics";
import { z } from "zod";
import { billingEnabled, syncBilling } from "./billing";
import { db } from "./db";
import { noticeAutoTopUp, noticeAutoTopUpFailed, type NoticeOrg, type NoticeOutcome } from "./notices";

/** `occurred_at`, when present: when it happened in Autumn, in ms. Only used to date a failure. */
const Envelope = z.object({ type: z.string(), occurred_at: z.number().int().positive().optional(), data: z.record(z.string(), z.unknown()) });
const Customer = z.object({ customer_id: z.uuid() });

const TopUpSucceeded = z.object({
  feature_id: z.string(),
  quantity_granted: z.number().nonnegative(),
  balance_after: z.number(),
  invoice: z.object({ stripe_id: z.string().min(1).max(255), total: z.number().int().nonnegative(), currency: z.string().regex(/^[a-zA-Z]{3}$/) }),
});

const TopUpFailed = z.object({ feature_id: z.string(), reason: z.string(), balance: z.number().nullish() });

/**
 * Failures an admin can fix, by what fixes them. The rest (Autumn's own
 * transient errors, no plan, a top-up already running) are not emailed.
 */
const FAILURE: Record<string, "card" | "limit" | undefined> = {
  charge_failed: "card",
  missing_payment_method: "card",
  payment_method_not_supported: "card",
  failed_attempt_limit_reached: "card",
  suspended_after_failures: "card",
  purchase_limit_reached: "limit",
  attempt_limit_reached: "limit",
  grant_limit_reached: "limit",
};

export type AutumnWebhookOutcome = { handled: string } | { ignored: string };

export async function handleAutumnEvent(payload: unknown): Promise<AutumnWebhookOutcome> {
  const envelope = Envelope.safeParse(payload);
  if (!envelope.success) return { ignored: "malformed" };
  const { type, data } = envelope.data;
  if (type !== "billing.auto_topup_succeeded" && type !== "billing.auto_topup_failed" && type !== "billing.updated") return { ignored: type };
  const customer = Customer.safeParse(data);
  if (!customer.success) return { ignored: "unknown customer" };
  const org = await db().query.orgs.findFirst({ where: (orgs, { eq }) => eq(orgs.id, customer.data.customer_id), columns: { id: true, githubLogin: true } });
  if (!org) return { ignored: "unknown customer" };

  if (type === "billing.updated") {
    if (!billingEnabled()) return { ignored: "billing is off" };
    await syncBilling(org);
    return { handled: type };
  }

  if (type === "billing.auto_topup_succeeded") {
    const event = TopUpSucceeded.safeParse(data);
    if (!event.success || event.data.feature_id !== CREDITS) return { ignored: "not credits" };
    const { quantity_granted: added, balance_after: credits, invoice } = event.data;
    const outcome = await noticeAutoTopUp(org, { invoiceId: invoice.stripe_id, added, credits, charged: money(invoice.total, invoice.currency) });
    if (outcome !== "duplicate") {
      const props = { credits_added: added, amount_minor: invoice.total, currency: invoice.currency.toLowerCase(), outcome: "ok" };
      recordLater([{ name: "auto_top_up_charged", orgId: org.id, props }]);
    }
    // Credits are back. Read the org from Autumn again, which re-arms the low and exhausted emails from the
    // balance as it is now. A repeat delivery of the same invoice changes nothing.
    if (outcome !== "duplicate") await refresh(org);
    return { handled: label(type, outcome) };
  }

  const event = TopUpFailed.safeParse(data);
  if (!event.success || event.data.feature_id !== CREDITS) return { ignored: "not credits" };
  const reason = FAILURE[event.data.reason];
  if (!reason) return { ignored: `auto top-up failed: ${event.data.reason}` };
  const at = new Date(envelope.data.occurred_at ?? Date.now());
  const notice = await noticeAutoTopUpFailed(org, { reason, credits: event.data.balance ?? null }, at);
  if (notice !== "duplicate") recordLater([{ name: "auto_top_up_charged", orgId: org.id, props: { credits_added: 0, outcome: reason } }]);
  return { handled: label(type, notice) };
}

function label(type: string, outcome: NoticeOutcome): string {
  return outcome === "sent" ? type : `${type} (${outcome === "duplicate" ? "already sent" : "no email"})`;
}

/** Reads the org from Autumn (which stores it and checks its credits), or with billing off lets the next page view do it. */
async function refresh(org: NoticeOrg): Promise<void> {
  if (billingEnabled()) await syncBilling(org);
  else await staleOrgBilling(db(), org.id);
}

/** Stripe amounts are in the currency's smallest unit; a few currencies have none smaller. */
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);

export function money(minor: number, currency: string): string {
  const code = currency.toLowerCase();
  const amount = ZERO_DECIMAL.has(code) ? minor : minor / 100;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: code.toUpperCase() }).format(amount);
}
