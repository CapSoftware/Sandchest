import { PageSkeleton } from "@/components/app/skeleton";
import { sampleSettings } from "@/lib/samples";
import { BillingView } from "../settings-view";

export default function Loading() {
  const { orgs, billing } = sampleSettings();
  return (
    <PageSkeleton id="settings-billing" label="Loading billing">
      <BillingView orgs={orgs} billing={[billing]} />
    </PageSkeleton>
  );
}
