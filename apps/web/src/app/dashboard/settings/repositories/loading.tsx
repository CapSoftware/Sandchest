import { PageSkeleton } from "@/components/app/skeleton";
import { sampleSettings } from "@/lib/samples";
import { RepositoriesView } from "../settings-view";

export default function Loading() {
  return (
    <PageSkeleton id="settings-repositories" label="Loading repositories">
      <RepositoriesView orgs={sampleSettings().orgs} memberOf={[]} />
    </PageSkeleton>
  );
}
