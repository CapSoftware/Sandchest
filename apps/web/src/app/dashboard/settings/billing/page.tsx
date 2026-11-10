import { settingsOrgs, usageHistory } from "@sandchest/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageShape } from "@/components/app/skeleton";
import { viewer } from "@/server/access";
import { billingEnabled, pageBilling } from "@/server/billing";
import { db } from "@/server/db";
import { BillingView } from "../settings-view";

export const metadata: Metadata = { title: "Billing · Settings · Sandchest" };

export default async function BillingSettingsPage() {
  const user = await viewer();
  // Self-hosted servers have no billing.
  if (!billingEnabled()) redirect("/dashboard/settings");
  const orgs = await settingsOrgs(db(), user.id);
  // Each org's billing, read from Autumn only where the stored copy is missing or old.
  // Each org's recent usage bills, of the repositories this person can see. Read alongside the billing.
  const [billing, bills] = await Promise.all([
    Promise.all(orgs.map((org) => pageBilling({ id: org.id, githubLogin: org.login }, org.billing))),
    Promise.all(orgs.map((org) => usageHistory(db(), user.id, org.id))),
  ]);
  const usage = Object.fromEntries(orgs.map((org, i) => [org.id, bills[i]!]));
  return (
    <PageShape id="settings-billing">
      <BillingView orgs={orgs} billing={billing} usage={usage} />
    </PageShape>
  );
}
