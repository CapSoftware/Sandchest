import { settingsOrgs } from "@sandchest/db";
import type { Metadata } from "next";
import { PageShape } from "@/components/app/skeleton";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { GeneralView } from "./settings-view";

export const metadata: Metadata = { title: "Settings · Sandchest" };

export default async function GeneralSettingsPage() {
  const user = await viewer();
  const orgs = await settingsOrgs(db(), user.id);
  return (
    <PageShape id="settings">
      <GeneralView orgs={orgs} />
    </PageShape>
  );
}
