"use server";
/**
 * Recruiting an org's hacker: who the company is, the repository to dig
 * first, how the hacker looks and talks, then joining the plan with the
 * credits to start on.
 *
 * Joining is paid for on the page when Stripe's keys are set: the browser
 * saves a card with Stripe's Payment Element (card details go to Stripe,
 * never here), the card becomes the Stripe customer's default, and Autumn
 * charges it for the plan and the credits. Anything that needs Stripe's own
 * pages (a card step on the charge, or no keys) falls back to them.
 */
import { AutumnError, DEFAULT_TOP_UP_LIMIT_USD, PLAN, StripeError } from "@sandchest/billing";
import { orgForAdmin, updateOrgSettings, userById } from "@sandchest/db";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Briefing } from "@/lib/briefing";
import { viewer } from "./access";
import { track } from "./analytics";
import { autumn, BILLING_FROZEN, billingEnabled, billingFrozen, stripe, stripePublishableKey, syncBilling } from "./billing";
import { purchase } from "./billing-actions";
import { briefing } from "./briefing";
import { config } from "./config";
import { db } from "./db";
import { CLAIM_COOKIE, closedMessage } from "@/lib/free-credits";
import { claimFreeCredits, codeOffer } from "./free-credits";
import { HackerSchema } from "./hacker-schema";
import { applyInvoiceDetails, InvoiceDetails, type InvoiceDetailsInput } from "./invoice-details";
import { describeError } from "./log";
import { PurchaseCredits } from "./purchase-credits";
import { captureException } from "./sentry";

/** `claimClosed`: free credits turned out not to be available for this account, so joining is paid after all. */
export type RecruitOutcome = { error?: string; claimClosed?: boolean };

const Company = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.union([z.literal(""), z.email().max(254)]),
});

const Recruitment = z.object({ hacker: HackerSchema, company: Company });
export type RecruitInput = z.input<typeof Recruitment>;

/** What joining buys: credits to start on, and whether auto top-up buys that many again when they run low. */
const Order = z.object({ credits: PurchaseCredits, autoTopUp: z.boolean() });
export type RecruitOrder = z.input<typeof Order>;
const Id = z.uuid();

const NOT_ADMIN = "Only an admin of this account can recruit its hacker.";
const PAYMENT_FAILED = "The payment didn’t go through, and nothing was charged. Check the card and try again.";

/** Saves everything chosen so far. */
async function save(userId: string, orgId: string, raw: unknown): Promise<RecruitOutcome> {
  if (!Id.safeParse(orgId).success) return { error: NOT_ADMIN };
  const input = Recruitment.safeParse(raw);
  if (!input.success) {
    const where = input.error.issues[0]?.path[0];
    if (where === "company") return { error: "Check the company name and billing email." };
    return { error: "Something about this hacker isn’t valid. Check the name: letters, numbers, spaces, dots and dashes, up to 16." };
  }
  const { hacker, company } = input.data;
  const ok = await updateOrgSettings(db(), userId, orgId, { hacker: { ...hacker, stickers: [...new Set(hacker.stickers)] }, company });
  if (!ok) return { error: NOT_ADMIN };
  revalidatePath("/dashboard", "layout");
  return {};
}

/** The briefing for another account, when the person switches accounts on the first step. */
export async function loadBriefing(orgId: string): Promise<Briefing | null> {
  const user = await viewer();
  if (!Id.safeParse(orgId).success) return null;
  const row = await userById(db(), user.id);
  return (await briefing({ id: user.id, email: row?.email ?? null }, orgId)) ?? null;
}

/** Keeps the auto top-up choice made while joining, with the default monthly limit: Autumn gets it once the plan is active. */
async function saveOrder(userId: string, orgId: string, order: z.output<typeof Order>): Promise<boolean> {
  const choice = { enabled: order.autoTopUp, quantity: order.credits, monthlyLimitUsd: DEFAULT_TOP_UP_LIMIT_USD };
  return updateOrgSettings(db(), userId, orgId, { autoTopUp: choice });
}

const json = (value: FormDataEntryValue | null): unknown => {
  try {
    return JSON.parse(String(value ?? ""));
  } catch {
    return undefined;
  }
};

/** Saves the recruitment, then (unless paying on the page) joins the plan with the credits chosen, or goes to the dashboard. */
export async function recruit(orgId: string, _previous: RecruitOutcome, form: FormData): Promise<RecruitOutcome> {
  const claiming = billingEnabled() && form.get("claim") === "1";
  const order = Order.safeParse(json(form.get("order")));
  // Claiming or joining moves credits or money: neither starts while billing is frozen.
  if (billingFrozen() && (claiming || order.success)) return { error: BILLING_FROZEN };
  const user = await viewer();
  const saved = await save(user.id, orgId, json(form.get("recruitment")));
  await track("recruit_submitted", {
    userId: user.id,
    orgId: saved.error ? null : orgId,
    props: { path: claiming ? "claim" : billingEnabled() && order.success ? "checkout" : "none", outcome: !saved.error ? "ok" : saved.error === NOT_ADMIN ? "not_admin" : "invalid" },
  });
  if (saved.error) return saved;

  // Free credits instead of paying: no card, nothing charged.
  if (claiming) {
    const result = await claimFreeCredits(user, orgId);
    await track("free_credits_claimed", { userId: user.id, orgId, props: { outcome: result.ok ? "ok" : result.reason } });
    if (!result.ok) {
      const row = await orgForAdmin(db(), user.id, orgId);
      const org = row?.org.githubLogin ?? "This account";
      switch (result.reason) {
        case "not_admin":
          return { error: NOT_ADMIN };
        case "failed":
        case "no_github_id":
          return { error: "The free credits couldn’t be added just now, and nothing was charged. Try again in a minute." };
        case "frozen":
          return { error: BILLING_FROZEN };
        default:
          return { error: `${closedMessage(result, org)} You can still join below.`, claimClosed: true };
      }
    }
    (await cookies()).delete(CLAIM_COOKIE);
    // Joined: the dashboard is where they choose what their hacker deep scans first.
    redirect("/dashboard?plan=started");
  }

  if (billingEnabled() && order.success) {
    const row = await orgForAdmin(db(), user.id, orgId);
    // Already on a plan: nothing to buy here.
    if (!row?.billing?.planId) {
      if (!(await saveOrder(user.id, orgId, order.data))) return { error: NOT_ADMIN };
      const purchaseForm = new FormData();
      purchaseForm.set("kind", "plan");
      purchaseForm.set("plan", PLAN.id);
      purchaseForm.set("credits", String(order.data.credits));
      // Redirects to Checkout or the confirm page; returns only with an error.
      return purchase(orgId, {}, purchaseForm);
    }
  }
  // No billing (a self-hosted server, or local dev): nothing to pay.
  redirect("/dashboard?recruited=1");
}

export type PaymentSetup = { error: string } | { clientSecret: string; publishableKey: string };

/**
 * Saves the recruitment and opens a card form for the org's first plan: a
 * SetupIntent on the Stripe customer Autumn bills.
 */
export async function preparePayment(orgId: string, raw: RecruitInput): Promise<PaymentSetup> {
  // No card form for a charge that would be refused.
  if (billingFrozen()) return { error: BILLING_FROZEN };
  const user = await viewer();
  const client = stripe();
  const publishableKey = stripePublishableKey();
  if (!client || !publishableKey) return { error: "Payment on this page isn’t available. Continue to Stripe instead." };
  const saved = await save(user.id, orgId, raw);
  if (saved.error) return { error: saved.error };
  const row = await orgForAdmin(db(), user.id, orgId);
  if (!row) return { error: NOT_ADMIN };
  const record = (outcome: string) => track("payment_form_opened", { userId: user.id, orgId, props: { outcome } });
  try {
    const { planId } = await syncBilling(row.org);
    if (planId) {
      await record("has_plan");
      return { error: `${row.org.githubLogin} already has a plan. Change it from Settings.` };
    }
    const customer = await autumn()!.stripeCustomer(row.org.id, row.org.githubLogin);
    const company = row.org.settings.company;
    if (company) await client.updateCustomer(customer, { name: company.name, email: company.email || undefined });
    const intent = await client.createSetupIntent({ customer, metadata: { sandchest_org: row.org.id } });
    await record("ok");
    return { clientSecret: intent.clientSecret, publishableKey };
  } catch (error) {
    console.error(`Payment setup for org ${orgId} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "payment_setup" }, handled: true });
    await record("error");
    return { error: "The payment form couldn’t open. Try again in a minute." };
  }
}


/** Puts the business's details on the Stripe customer, before the card is saved, so the first invoice carries them. */
export async function saveInvoiceDetails(orgId: string, raw: InvoiceDetailsInput): Promise<RecruitOutcome> {
  const user = await viewer();
  const client = stripe();
  const details = InvoiceDetails.safeParse(raw);
  if (!client || !details.success || !Id.safeParse(orgId).success) return { error: "Check the business details: a name and an address are needed." };
  const row = await orgForAdmin(db(), user.id, orgId);
  if (!row) return { error: NOT_ADMIN };
  const record = (outcome: string) => track("invoice_details_saved", { userId: user.id, orgId, props: { has_tax_id: !!details.data.taxId, country: details.data.address.country, outcome } });
  try {
    await applyInvoiceDetails(row.org, details.data);
    await record("ok");
    return {};
  } catch (error) {
    if (error instanceof StripeError && error.code === "tax_id_invalid") {
      await record("tax_id_invalid");
      return { error: "That tax ID doesn’t look right for the country. Check it, or leave it empty." };
    }
    await record("error");
    console.error(`Invoice details for org ${orgId} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "invoice_details" }, handled: true });
    return { error: "The business details couldn’t be saved, and nothing was charged. Try again in a minute." };
  }
}

/** A promotion code as people type them: letters, digits, dashes and underscores. */
const PromotionCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,64}$/);

/** A promotion code's discount, or (for a tester's code) free credits instead of paying. */
export type DiscountCheck = { error: string } | { code: string; discount: number; dueToday: number } | { code: string; freeCredits: number };

/** Checks a promotion code against this purchase: what it takes off, and what's then due today. Nothing is charged. */
export async function checkDiscount(orgId: string, rawCode: string, rawOrder: RecruitOrder): Promise<DiscountCheck> {
  if (billingFrozen()) return { error: BILLING_FROZEN };
  const user = await viewer();
  const code = PromotionCode.safeParse(rawCode);
  const order = Order.safeParse(rawOrder);
  if (!code.success) return { error: "That isn’t a code we know. Check it and try again." };
  if (!order.success || !Id.safeParse(orgId).success || !autumn()) return { error: "Codes can’t be checked right now. Try again in a minute." };
  const row = await orgForAdmin(db(), user.id, orgId);
  if (!row) return { error: NOT_ADMIN };
  // Never the code itself: it can be someone's personal code.
  const record = (outcome: string) => track("discount_checked", { userId: user.id, orgId, props: { credits: order.data.credits, outcome } });
  // A tester's code: free credits with no card, under the same rules as /claim.
  const offer = await codeOffer(user, orgId, code.data);
  if (offer) {
    await record(offer.open ? "free_credits" : "free_credits_closed");
    return offer.open ? { code: code.data.toUpperCase(), freeCredits: offer.credits } : { error: closedMessage(offer, row.org.githubLogin) };
  }
  try {
    const preview = await autumn()!.preview({ customerId: row.org.id, planId: PLAN.id, credits: order.data.credits, promotionCode: code.data });
    await record(preview.discount > 0 ? "ok" : "no_discount");
    if (preview.discount <= 0) return { error: "That code doesn’t take anything off this purchase." };
    return { code: code.data, discount: preview.discount, dueToday: preview.dueToday };
  } catch (error) {
    // Autumn doesn't document how it rejects a code; an unknown or expired one comes back as a client error.
    const invalid = error instanceof AutumnError && error.status >= 400 && error.status < 500;
    await record(invalid ? "invalid" : "error");
    if (invalid) return { error: "That code isn’t valid, or has expired." };
    console.error(`Discount check for org ${orgId} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "discount_check" }, handled: true });
    return { error: "Codes can’t be checked right now. Try again in a minute." };
  }
}

export type PaymentOutcome = { error: string } | { next: string };

/**
 * After the browser saved a card: saves the recruitment and the auto top-up
 * choice, checks the SetupIntent belongs to this org and succeeded, makes the
 * card the default, and has Autumn charge the plan and the starting credits.
 * Then waits briefly for the plan to show and starts the first Dig.
 */
export async function completePayment(orgId: string, rawOrder: RecruitOrder, setupIntentId: string, raw: RecruitInput, rawCode?: string): Promise<PaymentOutcome> {
  if (billingFrozen()) return { error: BILLING_FROZEN };
  const user = await viewer();
  const client = stripe();
  const order = Order.safeParse(rawOrder);
  const code = rawCode ? PromotionCode.safeParse(rawCode) : undefined;
  const record = (outcome: string, org: string | null = orgId) =>
    track("payment_completed", {
      userId: user.id,
      orgId: org,
      props: { credits: order.success ? order.data.credits : null, auto_top_up: order.success ? order.data.autoTopUp : null, discount: !!code, outcome },
    });
  if (!client || !order.success || !Id.safeParse(orgId).success || (code && !code.success)) {
    await record("invalid", null);
    return { error: PAYMENT_FAILED };
  }
  // Whatever changed since the card form opened (going back to rename the hacker, say) is saved first.
  const saved = await save(user.id, orgId, raw);
  if (saved.error) {
    await record(saved.error === NOT_ADMIN ? "not_admin" : "invalid", null);
    return { error: saved.error };
  }
  const row = (await saveOrder(user.id, orgId, order.data)) ? await orgForAdmin(db(), user.id, orgId) : undefined;
  if (!row) {
    await record("not_admin", null);
    return { error: NOT_ADMIN };
  }
  const appUrl = config().SANDCHEST_APP_URL.replace(/\/$/, "");
  let charging = false;
  try {
    const before = await syncBilling(row.org);
    if (!before.planId) {
      const customer = await autumn()!.stripeCustomer(row.org.id, row.org.githubLogin);
      const intent = await client.setupIntent(setupIntentId);
      if (intent.customer !== customer || intent.metadata.sandchest_org !== row.org.id || intent.status !== "succeeded" || !intent.paymentMethod) {
        await record("card_not_saved");
        return { error: PAYMENT_FAILED };
      }
      await client.updateCustomer(customer, { defaultPaymentMethod: intent.paymentMethod });
      charging = true;
      const { paymentUrl } = await autumn()!.attach({
        customerId: row.org.id,
        planId: PLAN.id,
        credits: order.data.credits,
        promotionCode: code?.data,
        successUrl: `${appUrl}/dashboard/billing/return?org=${row.org.id}`,
      });
      // A card step on the charge itself: Stripe's page finishes it and sends them back.
      if (paymentUrl) {
        await record("card_step");
        return { next: paymentUrl };
      }
      let state = await syncBilling(row.org);
      for (let attempt = 0; !state.planId && attempt < 6; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        state = await syncBilling(row.org);
      }
      if (!state.planId) {
        await record("pending");
        return { next: `/dashboard/billing/return?org=${row.org.id}` };
      }
      await record("ok");
    } else {
      await record("has_plan");
    }
  } catch (error) {
    console.error(`Payment for org ${orgId} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "payment_complete" }, handled: true });
    await record(charging ? "unknown" : "failed");
    // Once the charge was asked for, it may have gone through: send them to look rather than pay again.
    return charging ? { next: `/dashboard/billing/return?org=${row.org.id}` } : { error: PAYMENT_FAILED };
  }
  return { next: "/dashboard?plan=started" };
}
