import { settingsOrgs, userAgentAccess } from "@sandchest/db";
import type { Metadata } from "next";
import { PageShape } from "@/components/app/skeleton";
import { viewer } from "@/server/access";
import { billingEnabled, pageBilling } from "@/server/billing";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { SettingsView } from "./settings-view";

export const metadata: Metadata = { title: "Settings · Sandchest" };

export default async function SettingsPage() {
  const user = await viewer();
  const [orgs, access] = await Promise.all([settingsOrgs(db(), user.id), userAgentAccess(db(), user.id)]);
  // Each org's billing, read from Autumn only where the stored copy is missing or old.
  const billing = billingEnabled() ? await Promise.all(orgs.map((org) => pageBilling({ id: org.id, githubLogin: org.login }, org.billing))) : null;
  return (
    <PageShape id="settings">
      <SettingsView user={user} orgs={orgs} billing={billing} access={access} appUrl={config().SANDCHEST_APP_URL.replace(/\/$/, "")} />
    </PageShape>
  );
}
