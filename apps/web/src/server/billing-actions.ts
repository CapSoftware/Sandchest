"use server";
/**
 * What an org admin can do with billing. Each action checks, in SQL, that the
 * viewer is an admin of the org: GitHub org admins, or the owner of a
 * personal account (SPEC §3).
 *
 * Without a card on file, the plan (and any credits bought with it) goes
 * through Stripe Checkout. Once the org has one, every charge is shown on a
 * confirm page first, then charged at once. Each confirm page carries a
 * purchase id the charge is made under, so confirming it again (a second
 * tab, a retry after a timeout) never charges twice.
 */
import { DEFAULT_CREDITS, DEFAULT_TOP_UP_LIMIT_USD, isTrial, PLAN, PLANS, TOP_UP, type PlanId } from "@sandchest/billing";
import { orgForAdmin, updateOrgSettings } from "@sandchest/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { currentUser, viewer } from "./access";
import { track } from "./analytics";
import { autumn, buyCredits, chargePurchase, saveAutoTopUpChoice, syncBilling } from "./billing";
import { config } from "./config";
import { db } from "./db";
import { describeError } from "./log";
import { PurchaseCredits } from "./purchase-credits";
import { captureException } from "./sentry";

export type BillingOutcome = { error?: string; saved?: boolean };

const Id = z.uuid();
const Credits = PurchaseCredits;
/** Plans that can be bought now: the retired ones keep working but aren't sold. */
const OfferedPlan = z.enum(PLANS.filter((p) => p.offered).map((p) => p.id) as [PlanId, ...PlanId[]]);
const Purchase = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("plan"),
    plan: OfferedPlan,
    credits: z.union([z.literal("").transform(() => undefined), Credits]).optional(),
    /** Joining from the plan picker: whether auto top-up starts on. */
    autoTopUp: z.enum(["on", "off"]).optional(),
  }),
  z.object({ kind: z.literal("top_up"), credits: Credits }),
]);
export type PurchaseInput = z.infer<typeof Purchase>;

const NOT_ADMIN = "Only an admin of this account can change its billing.";
const FAILED = "Billing didn’t go through. Check your plan and credits before trying again.";
// A confirmed charge that wasn't answered may have gone through, but sending it again charges it once.
const UNCONFIRMED = "Billing didn’t confirm this purchase, so it may or may not have been charged. Trying again here won’t charge it twice.";

async function adminOrg(orgId: string) {
  if (!Id.safeParse(orgId).success || !autumn()) return undefined;
  const user = await viewer();
  return orgForAdmin(db(), user.id, orgId);
}

function appUrl(): string {
  return config().SANDCHEST_APP_URL.replace(/\/$/, "");
}

/** Where a purchase is confirmed: the plan, or the credits bought on their own, in the query string. */
function purchaseQuery(input: PurchaseInput): string {
  return input.kind === "plan" ? `plan=${input.plan}${input.credits ? `&credits=${input.credits}` : ""}` : `topup=${input.credits}`;
}

/** What a purchase was, as recorded: its kind, plan and credits. */
const purchaseProps = (input: PurchaseInput) => ({
  kind: input.kind,
  plan: input.kind === "plan" ? input.plan : null,
  credits: input.credits ?? null,
  ...(input.kind === "plan" && input.autoTopUp ? { auto_top_up: input.autoTopUp === "on" } : {}),
});

/** Records a billing step, then hands back its outcome. The org is named only once it was found (it is a foreign key). */
async function tracked<T extends BillingOutcome>(
  name: "purchase_started" | "purchase_confirmed",
  context: { orgId?: string; input?: PurchaseInput; route?: string },
  result: T,
  reason: string,
): Promise<T> {
  const user = await currentUser().catch(() => undefined);
  await track(name, {
    userId: user?.id,
    orgId: context.orgId,
    props: { ...(context.input ? purchaseProps(context.input) : {}), ...(context.route ? { route: context.route } : {}), outcome: result.error ? reason : "ok" },
  });
  return result;
}

/** Picks or changes the plan, or buys credits. Without a card on file this opens Stripe Checkout. */
export async function purchase(orgId: string, _previous: BillingOutcome, form: FormData): Promise<BillingOutcome> {
  const input = Purchase.safeParse(Object.fromEntries(form));
  if (!input.success) return tracked("purchase_started", {}, { error: "That isn’t something you can buy." }, "invalid");
  const row = await adminOrg(orgId);
  if (!row) return tracked("purchase_started", { input: input.data }, { error: NOT_ADMIN }, "not_admin");
  const context = { orgId, input: input.data };
  // Read Autumn rather than the stored copy, which can be a minute old. This also creates the customer.
  let planId: string | null;
  try {
    ({ planId } = await syncBilling(row.org));
  } catch (error) {
    console.error(`Billing read for org ${orgId} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "read" }, handled: true });
    return tracked("purchase_started", context, { error: FAILED }, "error");
  }
  if (input.data.kind === "plan" && planId === input.data.plan) return tracked("purchase_started", context, { error: "That’s already your plan." }, "same_plan");
  // No plan, or only the free one: no card on file, so the plan (with its credits) is bought on Stripe Checkout.
  if (!planId || isTrial(planId)) {
    if (input.data.kind === "top_up") return tracked("purchase_started", context, { error: "Join the plan first: credits are bought with it." }, "needs_plan");
    // Kept with the org's settings: Autumn gets it once the plan is active.
    if (input.data.autoTopUp) {
      const quantity = input.data.credits ?? DEFAULT_CREDITS;
      const choice = { enabled: input.data.autoTopUp === "on", quantity, monthlyLimitUsd: DEFAULT_TOP_UP_LIMIT_USD };
      if (!(await updateOrgSettings(db(), (await viewer()).id, orgId, { autoTopUp: choice }))) return tracked("purchase_started", context, { error: NOT_ADMIN }, "not_admin");
    }
    return checkout(row.org, input.data, "purchase_started");
  }
  await tracked("purchase_started", { ...context, route: "confirm" }, {}, "ok");
  redirect(`/dashboard/billing/confirm?org=${orgId}&${purchaseQuery(input.data)}&purchase=${crypto.randomUUID()}`);
}

/** Charges a purchase the admin confirmed. */
export async function confirmPurchase(orgId: string, _previous: BillingOutcome, form: FormData): Promise<BillingOutcome> {
  const input = Purchase.safeParse(Object.fromEntries(form));
  if (!input.success) return tracked("purchase_confirmed", {}, { error: "That isn’t something you can buy." }, "invalid");
  const row = await adminOrg(orgId);
  if (!row) return tracked("purchase_confirmed", { input: input.data }, { error: NOT_ADMIN }, "not_admin");
  const context = { orgId, input: input.data };
  // Free credits don't sell credits on their own: joining the plan comes first, as from Settings.
  if (input.data.kind === "top_up" && (!row.billing?.planId || isTrial(row.billing.planId))) {
    return tracked("purchase_confirmed", context, { error: "Join the plan first: credits are bought with it." }, "needs_plan");
  }
  // A page opened before purchases had ids: reloading it gives it one.
  const purchaseId = Id.safeParse(form.get("purchase"));
  if (!purchaseId.success) return tracked("purchase_confirmed", context, { error: "This page is out of date. Reload it and confirm again." }, "stale");
  return checkout(row.org, input.data, "purchase_confirmed", purchaseId.data);
}

/**
 * Charges the purchase, or opens Stripe for it, recording the step that led here with where it went. A confirmed
 * purchase is charged under its id: one asked for already goes to the return page, which shows what it bought.
 */
async function checkout(org: { id: string; githubLogin: string }, input: PurchaseInput, step: "purchase_started" | "purchase_confirmed", purchaseId?: string): Promise<BillingOutcome> {
  const successUrl = `${appUrl()}/dashboard/billing/return?org=${org.id}`;
  const purchase = { planId: input.kind === "plan" ? input.plan : TOP_UP.id, credits: input.credits, successUrl };
  let paymentUrl: string | null;
  let repeated: boolean | undefined;
  try {
    ({ paymentUrl, repeated } = purchaseId ? await chargePurchase(org, purchaseId, purchase) : await autumn()!.attach({ customerId: org.id, ...purchase }));
  } catch (error) {
    console.error(`Purchase for org ${org.id} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "purchase" }, handled: true });
    return tracked(step, { orgId: org.id, input }, { error: purchaseId ? UNCONFIRMED : FAILED }, "checkout_failed");
  }
  await tracked(step, { orgId: org.id, input, route: repeated ? "repeated" : paymentUrl ? "stripe" : "charged" }, {}, "ok");
  // Checkout, or a card step (3-D Secure, a declined card): Stripe sends them back to the return page.
  if (paymentUrl) redirect(paymentUrl);
  redirect(`/dashboard/billing/return?org=${org.id}`);
}

/** What the add-credits dialog is told: the price today, or why it can't be bought here. */
export type CreditsQuote = { dueToday?: number; joins?: boolean; error?: string };
export type AddCreditsOutcome = { error?: string; added?: number; credits?: number };

/**
 * What buying `credits` charges today. On a paid plan it's credits alone, charged to the card on file;
 * without one (no plan, or free credits) it's joining the plan with them, on Stripe.
 */
export async function quoteCredits(orgId: string, credits: number): Promise<CreditsQuote> {
  const amount = Credits.safeParse(credits);
  if (!amount.success) return { error: "That isn’t something you can buy." };
  const row = await adminOrg(orgId);
  if (!row) return { error: NOT_ADMIN };
  try {
    const { planId } = await syncBilling(row.org);
    const joins = !planId || isTrial(planId);
    const preview = await autumn()!.preview({ customerId: row.org.id, planId: joins ? PLAN.id : TOP_UP.id, credits: amount.data });
    return { dueToday: preview.dueToday, joins };
  } catch (error) {
    console.error(`Pricing credits for org ${orgId} failed: ${describeError(error)}`);
    return { error: "Billing couldn’t price this right now. Try again in a minute." };
  }
}

/**
 * Buys credits from the add-credits dialog, which showed the price first. On a paid plan they're charged to
 * the card on file at once, under `purchaseId`, so a retry or a second press never charges twice; without
 * one, Stripe Checkout joins the plan with them. A card that needs a check (3-D Secure) goes to Stripe too.
 */
export async function addCredits(orgId: string, credits: number, purchaseId: string): Promise<AddCreditsOutcome> {
  const amount = Credits.safeParse(credits);
  const id = Id.safeParse(purchaseId);
  if (!amount.success || !id.success) return { error: "That isn’t something you can buy." };
  const row = await adminOrg(orgId);
  if (!row) return { error: NOT_ADMIN };
  let bought: Awaited<ReturnType<typeof buyCredits>>;
  try {
    bought = await buyCredits(row.org, amount.data, id.data, `${appUrl()}/dashboard/billing/return?org=${orgId}`);
  } catch (error) {
    console.error(`Adding credits for org ${orgId} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "add_credits" }, handled: true });
    return tracked("purchase_confirmed", { orgId, input: { kind: "top_up", credits: amount.data } }, { error: UNCONFIRMED }, "checkout_failed");
  }
  const input: PurchaseInput = bought.joins ? { kind: "plan", plan: PLAN.id as PlanId, credits: amount.data } : { kind: "top_up", credits: amount.data };
  await tracked(bought.joins ? "purchase_started" : "purchase_confirmed", { orgId, input, route: bought.repeated ? "repeated" : bought.paymentUrl ? "stripe" : "dialog" }, {}, "ok");
  if (bought.paymentUrl) redirect(bought.paymentUrl);
  revalidatePath("/dashboard", "layout");
  return { added: amount.data, credits: bought.credits };
}

/** Opens Stripe's billing portal: card, invoices and cancelling. */
export async function openPortal(orgId: string): Promise<void> {
  const row = await adminOrg(orgId);
  if (!row) redirect("/dashboard/settings");
  const userId = (await viewer()).id;
  let url: string;
  try {
    url = await autumn()!.portal(orgId, `${appUrl()}/dashboard/billing/return?org=${orgId}`);
  } catch (error) {
    console.error(`Billing portal for org ${orgId} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "portal" }, handled: true });
    await track("billing_portal_opened", { userId, orgId, props: { outcome: "error" } });
    redirect("/dashboard/settings/billing?billing=unavailable");
  }
  await track("billing_portal_opened", { userId, orgId, props: { outcome: "ok" } });
  redirect(url);
}

const AutoTopUpForm = z.object({
  enabled: z.literal("on").optional(),
  quantity: Credits.optional(),
  /** Empty: no monthly limit. */
  limit: z.union([z.literal("").transform(() => null), z.coerce.number().int().min(1).max(100_000)]).optional(),
});

/** Turns auto top-up on or off: how many credits it buys, and the most it may spend in a month. */
export async function saveAutoTopUp(orgId: string, _previous: BillingOutcome, form: FormData): Promise<BillingOutcome> {
  const parsed = AutoTopUpForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "The monthly limit must be at least $1, or empty for no limit." };
  const row = await adminOrg(orgId);
  if (!row) return { error: NOT_ADMIN };
  const user = await viewer();
  const input = { enabled: parsed.data.enabled === "on", quantity: parsed.data.quantity, monthlyLimitUsd: parsed.data.limit ?? null };
  const record = (outcome: string, choice?: { enabled: boolean; quantity?: number; monthlyLimitUsd: number | null }) =>
    track("auto_top_up_saved", {
      userId: user.id,
      orgId,
      props: { enabled: input.enabled, quantity: choice?.quantity ?? input.quantity ?? null, monthly_limit_usd: choice?.monthlyLimitUsd ?? input.monthlyLimitUsd, outcome },
    });
  let result: Awaited<ReturnType<typeof saveAutoTopUpChoice>>;
  try {
    result = await saveAutoTopUpChoice(user.id, row, input);
  } catch (error) {
    console.error(`Auto top-up for org ${orgId} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "auto_top_up" }, handled: true });
    await record("error");
    return { error: "Saved here, but billing didn’t take the change. Try again in a minute." };
  }
  if (!result.ok) return { error: result.reason === "no_plan" ? "Auto top-up needs a plan with a card: join Standard first." : NOT_ADMIN };
  await record("ok", result.choice);
  revalidatePath("/dashboard/settings", "layout");
  return { saved: true };
}
