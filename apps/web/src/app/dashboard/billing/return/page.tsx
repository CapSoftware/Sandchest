import { isTrial } from "@sandchest/billing/plans";
import { orgForAdmin } from "@sandchest/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { isUuid } from "@/lib/uuid";
import { viewer } from "@/server/access";
import { track } from "@/server/analytics";
import { autumn, syncBilling } from "@/server/billing";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Billing · Sandchest" };

/**
 * Back from Stripe (Checkout, a card step or the billing portal): reads the
 * org's billing again so the dashboard shows the change at once. Stripe can
 * send the person back a moment before Autumn has the payment, so a first
 * plan is waited for briefly. A first plan starts recon on every repository,
 * and the first Dig if one was chosen while recruiting.
 */
export default async function BillingReturn({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgId } = await searchParams;
  const user = await viewer();
  const row = autumn() && isUuid(orgId) ? await orgForAdmin(db(), user.id, orgId) : undefined;
  if (!row) redirect("/dashboard/settings");

  const hadPlan = !!row.billing?.planId;
  // Free credits are not a paid plan: joining from them is waited for like a first plan.
  const paying = (planId: string | null | undefined) => !!planId && !isTrial(planId);
  const hadPaid = paying(row.billing?.planId);
  let state = await syncBilling(row.org).catch(() => undefined);
  for (let attempt = 0; !hadPaid && !paying(state?.planId) && attempt < 6; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    state = await syncBilling(row.org).catch(() => state);
  }
  const planNow = state?.planId ? (isTrial(state.planId) ? "free" : "paid") : "none";
  // A first plan; a paid plan where there was none (free credits before); still no paid plan (abandoned, or slower
  // than the wait); or a change on a paid plan (credits, the portal).
  const outcome = !hadPlan && state?.planId ? "first_plan" : hadPaid ? "unchanged" : paying(state?.planId) ? "paid" : "pending";
  await track("billing_returned", { userId: user.id, orgId: row.org.id, props: { had_plan: hadPlan, had_paid_plan: hadPaid, plan_now: planNow, outcome } });
  if (!hadPlan && state?.planId) {
    // A first plan: the hacker starts on the repository chosen while recruiting, if there was one.
    const { startFirstTarget } = await import("@/server/first-target");
    redirect(await startFirstTarget(user.id, row.org));
  }
  redirect("/dashboard/settings/billing");
}
