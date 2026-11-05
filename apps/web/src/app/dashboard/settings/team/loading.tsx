import { PageSkeleton } from "@/components/app/skeleton";
import { sampleSettings } from "@/lib/samples";
import { teamRows } from "@/lib/team";
import { TeamView } from "../settings-view";

export default function Loading() {
  const { orgs, team } = sampleSettings();
  return (
    <PageSkeleton id="settings-team" label="Loading the team">
      <TeamView orgs={orgs} teams={{ [orgs[0]!.id]: teamRows(team) }} memberOf={[]} />
    </PageSkeleton>
  );
}
