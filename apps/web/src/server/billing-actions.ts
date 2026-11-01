"use server";
/**
 * What an org admin can do with billing. Each action checks, in SQL, that the
 * viewer is an admin of the org: GitHub org admins, or the owner of a
 * personal account (SPEC §3).
 *
 * A first plan goes through Stripe Checkout. Once the org has a card on file,
 * every charge is shown on a confirm page first, then charged at once.
 */
import { defaultAutoTopUpLimit, MAX_TOP_UP_PACKS, planById, PLANS, TOP_UP, type PlanId } from "@sandchest/billing";
import { orgForAdmin, updateOrgSettings } from "@sandchest/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { viewer } from "./access";
import { applyAutoTopUp, autumn, syncBilling } from "./billing";
import { config } from "./config";
import { db } from "./db";

export type BillingOutcome = { error?: string; saved?: boolean };

const Id = z.uuid();
const Purchase = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), plan: z.enum(PLANS.map((p) => p.id) as [PlanId, ...PlanId[]]) }),
  z.object({ kind: z.literal("top_up"), packs: z.coerce.number().int().min(1).max(MAX_TOP_UP_PACKS) }),
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

/** Where a purchase is confirmed: the plan or the number of top-up packs, in the query string. */
function purchaseQuery(input: PurchaseInput): string {
  return input.kind === "plan" ? `plan=${input.plan}` : `topup=${input.packs}`;
}

/** Picks or changes a plan, or buys top-ups. Without a card on file this opens Stripe Checkout. */
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
    console.error(`Billing read for org ${orgId} failed: ${error instanceof Error ? error.message : "error"}`);
    return { error: FAILED };
  }
  if (input.data.kind === "plan" && planId === input.data.plan) return { error: "That’s already your plan." };
  if (!planId) {
    if (input.data.kind === "top_up") return { error: "Choose a plan first: top-ups add to a plan’s credits." };
    return checkout(row.org, input.data);
  }
  redirect(`/billing/confirm?org=${orgId}&${purchaseQuery(input.data)}`);
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
  const successUrl = `${appUrl()}/billing/return?org=${org.id}`;
  let paymentUrl: string | null;
  try {
    ({ paymentUrl } = await autumn()!.attach({
      customerId: org.id,
      planId: input.kind === "plan" ? input.plan : TOP_UP.id,
      packs: input.kind === "top_up" ? input.packs : undefined,
      successUrl,
    }));
  } catch (error) {
    console.error(`Purchase for org ${org.id} failed: ${error instanceof Error ? error.message : "error"}`);
    return { error: FAILED };
  }
  // Checkout, or a card step (3-D Secure, a declined card): Stripe sends them back to the return page.
  if (paymentUrl) redirect(paymentUrl);
  redirect(`/billing/return?org=${org.id}`);
}

/** Opens Stripe's billing portal: card, invoices and cancelling. */
export async function openPortal(orgId: string): Promise<void> {
  const row = await adminOrg(orgId);
  if (!row) redirect("/settings");
  let url: string;
  try {
    url = await autumn()!.portal(orgId, `${appUrl()}/billing/return?org=${orgId}`);
  } catch (error) {
    console.error(`Billing portal for org ${orgId} failed: ${error instanceof Error ? error.message : "error"}`);
    redirect("/settings?billing=unavailable#billing");
  }
  redirect(url);
}

const AutoTopUpForm = z.object({
  enabled: z.literal("on").optional(),
  limit: z.coerce.number().int().min(TOP_UP.price).max(100_000),
});

/** Turns auto top-up on or off, with a monthly spend limit. */
export async function saveAutoTopUp(orgId: string, _previous: BillingOutcome, form: FormData): Promise<BillingOutcome> {
  const parsed = AutoTopUpForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: `The monthly limit must be at least $${TOP_UP.price}.` };
  const row = await adminOrg(orgId);
  if (!row) return { error: NOT_ADMIN };
  const plan = planById(row.billing?.planId);
  if (!plan) return { error: "Auto top-up needs a plan." };
  const choice = { enabled: parsed.data.enabled === "on", monthlyLimitUsd: parsed.data.limit || defaultAutoTopUpLimit(plan) };
  const user = await viewer();
  if (!(await updateOrgSettings(db(), user.id, orgId, { autoTopUp: choice }))) return { error: NOT_ADMIN };
  try {
    await applyAutoTopUp(orgId, plan.id, choice);
    await syncBilling(row.org);
  } catch (error) {
    console.error(`Auto top-up for org ${orgId} failed: ${error instanceof Error ? error.message : "error"}`);
    return { error: "Saved here, but billing didn’t take the change. Try again in a minute." };
  }
  revalidatePath("/settings");
  return { saved: true };
}
