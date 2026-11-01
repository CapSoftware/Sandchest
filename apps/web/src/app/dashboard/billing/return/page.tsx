import { orgForAdmin } from "@sandchest/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { viewer } from "@/server/access";
import { autumn, syncBilling } from "@/server/billing";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Billing · Sandchest" };

/**
 * Back from Stripe (Checkout, a card step or the billing portal): reads the
 * org's billing again so the dashboard shows the change at once. Stripe can
 * send the person back a moment before Autumn has the payment, so a first
 * plan is waited for briefly. A first plan starts recon on every repository.
 */
export default async function BillingReturn({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org: orgId } = await searchParams;
  const user = await viewer();
  const row = autumn() && orgId && /^[0-9a-f-]{36}$/.test(orgId) ? await orgForAdmin(db(), user.id, orgId) : undefined;
  if (!row) redirect("/dashboard/settings");

  const hadPlan = !!row.billing?.planId;
  let state = await syncBilling(row.org).catch(() => undefined);
  for (let attempt = 0; !hadPlan && !state?.planId && attempt < 6; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    state = await syncBilling(row.org).catch(() => state);
  }
  if (!hadPlan && state?.planId) redirect("/dashboard?plan=started");
  redirect("/dashboard/settings#billing");
}
