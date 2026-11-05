import type { Metadata } from "next";
import { demoSettings } from "@/lib/demo";
import { teamRows } from "@/lib/team";
import { TeamView } from "../../../dashboard/settings/settings-view";

export const metadata: Metadata = { title: "Team · Settings · Sandchest demo" };

export default function DemoTeamPage() {
  const { orgs, team } = demoSettings();
  return <TeamView orgs={orgs} teams={{ [orgs[0]!.id]: teamRows(team) }} memberOf={[]} />;
}
