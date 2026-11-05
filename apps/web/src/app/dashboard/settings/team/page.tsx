import { adminTeams, memberOrgIds, settingsOrgs } from "@sandchest/db";
import type { Metadata } from "next";
import { PageShape } from "@/components/app/skeleton";
import { teamRows } from "@/lib/team";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { TeamView } from "../settings-view";

export const metadata: Metadata = { title: "Team · Settings · Sandchest" };

export default async function TeamSettingsPage() {
  const user = await viewer();
  const [orgs, teams, memberOf] = await Promise.all([settingsOrgs(db(), user.id), adminTeams(db(), user.id), memberOrgIds(db(), user.id)]);
  return (
    <PageShape id="settings-team">
      <TeamView orgs={orgs} teams={Object.fromEntries([...teams].map(([orgId, team]) => [orgId, teamRows(team)]))} memberOf={[...memberOf]} />
    </PageShape>
  );
}
