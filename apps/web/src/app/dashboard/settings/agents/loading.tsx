import { PageSkeleton } from "@/components/app/skeleton";
import { config } from "@/server/config";
import { AgentsView } from "../settings-view";

export default function Loading() {
  return (
    <PageSkeleton id="settings-agents" label="Loading agents">
      <AgentsView access={[]} appUrl={config().SANDCHEST_APP_URL.replace(/\/$/, "")} />
    </PageSkeleton>
  );
}
