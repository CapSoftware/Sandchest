import { memberOrgIds, settingsOrgs } from "@sandchest/db";
import type { Metadata } from "next";
import { PageShape } from "@/components/app/skeleton";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { RepositoriesView } from "../settings-view";

export const metadata: Metadata = { title: "Repositories · Settings · Sandchest" };

export default async function RepositoriesSettingsPage() {
  const user = await viewer();
  const [orgs, memberOf] = await Promise.all([settingsOrgs(db(), user.id), memberOrgIds(db(), user.id)]);
  return (
    <PageShape id="settings-repositories">
      <RepositoriesView orgs={orgs} memberOf={[...memberOf]} />
    </PageShape>
  );
}
