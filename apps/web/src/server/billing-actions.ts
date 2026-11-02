"use server";
/**
 * What an org admin can do with billing. Each action checks, in SQL, that the
 * viewer is an admin of the org: GitHub org admins, or the owner of a
 * personal account (SPEC §3).
 *
 * Without a card on file, the plan (and any credits bought with it) goes
 * through Stripe Checkout. Once the org has one, every charge is shown on a
 * confirm page first, then charged at once.
 */
import { DEFAULT_CREDITS, defaultAutoTopUpLimit, MAX_PURCHASE_CREDITS, planById, PLANS, TOP_UP, type PlanId } from "@sandchest/billing";
import { orgForAdmin, updateOrgSettings } from "@sandchest/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { viewer } from "./access";
import { applyAutoTopUp, autumn, syncBilling } from "./billing";
import { config } from "./config";
import { db } from "./db";
import { describeError } from "./log";
import { captureException } from "./sentry";

export type BillingOutcome = { error?: string; saved?: boolean };

const Id = z.uuid();
const Credits = z.coerce.number().int().min(1).max(MAX_PURCHASE_CREDITS);
/** Plans that can be bought now: the retired ones keep working but aren't sold. */
const OfferedPlan = z.enum(PLANS.filter((p) => p.offered).map((p) => p.id) as [PlanId, ...PlanId[]]);
const Purchase = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), plan: OfferedPlan, credits: z.union([z.literal("").transform(() => undefined), Credits]).optional() }),
  z.object({ kind: z.literal("top_up"), credits: Credits }),
]);
export type PurchaseInput = z.infer<typeof Purchase>;

const NOT_ADMIN = "Only an admin of this account can change its billing.";
const FAILED = "Billing didn’t go through. Check your plan and credits before trying again.";

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

/** Picks or changes the plan, or buys credits. Without a card on file this opens Stripe Checkout. */
export async function purchase(orgId: string, _previous: BillingOutcome, form: FormData): Promise<BillingOutcome> {
  const input = Purchase.safeParse(Object.fromEntries(form));
  if (!input.success) return { error: "That isn’t something you can buy." };
  const row = await adminOrg(orgId);
  if (!row) return { error: NOT_ADMIN };
  // Read Autumn rather than the stored copy, which can be a minute old. This also creates the customer.
  let planId: string | null;
  try {
    ({ planId } = await syncBilling(row.org));
  } catch (error) {
    console.error(`Billing read for org ${orgId} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "read" }, handled: true });
    return { error: FAILED };
  }
  if (input.data.kind === "plan" && planId === input.data.plan) return { error: "That’s already your plan." };
  if (!planId) {
    if (input.data.kind === "top_up") return { error: "Join the plan first: credits are bought with it." };
    return checkout(row.org, input.data);
  }
  redirect(`/dashboard/billing/confirm?org=${orgId}&${purchaseQuery(input.data)}`);
}

/** Charges a purchase the admin confirmed. */
export async function confirmPurchase(orgId: string, _previous: BillingOutcome, form: FormData): Promise<BillingOutcome> {
  const input = Purchase.safeParse(Object.fromEntries(form));
  if (!input.success) return { error: "That isn’t something you can buy." };
  const row = await adminOrg(orgId);
  if (!row) return { error: NOT_ADMIN };
  return checkout(row.org, input.data);
}

async function checkout(org: { id: string; githubLogin: string }, input: PurchaseInput): Promise<BillingOutcome> {
  const successUrl = `${appUrl()}/dashboard/billing/return?org=${org.id}`;
  let paymentUrl: string | null;
  try {
    ({ paymentUrl } = await autumn()!.attach({
      customerId: org.id,
      planId: input.kind === "plan" ? input.plan : TOP_UP.id,
      credits: input.credits,
      successUrl,
    }));
  } catch (error) {
    console.error(`Purchase for org ${org.id} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "purchase" }, handled: true });
    return { error: FAILED };
  }
  // Checkout, or a card step (3-D Secure, a declined card): Stripe sends them back to the return page.
  if (paymentUrl) redirect(paymentUrl);
  redirect(`/dashboard/billing/return?org=${org.id}`);
}

/** Opens Stripe's billing portal: card, invoices and cancelling. */
export async function openPortal(orgId: string): Promise<void> {
  const row = await adminOrg(orgId);
  if (!row) redirect("/dashboard/settings");
  let url: string;
  try {
    url = await autumn()!.portal(orgId, `${appUrl()}/dashboard/billing/return?org=${orgId}`);
  } catch (error) {
    console.error(`Billing portal for org ${orgId} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "portal" }, handled: true });
    redirect("/dashboard/settings?billing=unavailable#billing");
  }
  redirect(url);
}

const AutoTopUpForm = z.object({
  enabled: z.literal("on").optional(),
  quantity: Credits.optional(),
  limit: z.coerce.number().int().min(1).max(100_000),
});

/** Turns auto top-up on or off: how many credits it buys, and the most it may spend in a month. */
export async function saveAutoTopUp(orgId: string, _previous: BillingOutcome, form: FormData): Promise<BillingOutcome> {
  const parsed = AutoTopUpForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: "The monthly limit must be at least $1." };
  const row = await adminOrg(orgId);
  if (!row) return { error: NOT_ADMIN };
  const plan = planById(row.billing?.planId);
  if (!plan) return { error: "Auto top-up needs a plan." };
  const quantity = parsed.data.quantity ?? row.org.settings.autoTopUp?.quantity ?? DEFAULT_CREDITS;
  const choice = { enabled: parsed.data.enabled === "on", quantity, monthlyLimitUsd: parsed.data.limit || defaultAutoTopUpLimit(quantity) };
  const user = await viewer();
  if (!(await updateOrgSettings(db(), user.id, orgId, { autoTopUp: choice }))) return { error: NOT_ADMIN };
  try {
    await applyAutoTopUp(orgId, plan.id, choice);
    await syncBilling(row.org);
  } catch (error) {
    console.error(`Auto top-up for org ${orgId} failed: ${describeError(error)}`);
    await captureException(error, { source: "billing", tags: { action: "auto_top_up" }, handled: true });
    return { error: "Saved here, but billing didn’t take the change. Try again in a minute." };
  }
  revalidatePath("/dashboard/settings");
  return { saved: true };
}
