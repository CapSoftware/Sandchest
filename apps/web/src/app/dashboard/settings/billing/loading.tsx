import { PageSkeleton } from "@/components/app/skeleton";
import { sampleSettings, sampleUsageHistory } from "@/lib/samples";
import { scanPricingMode } from "@/server/config";
import { BillingView } from "../settings-view";

export default function Loading() {
  const { orgs, billing } = sampleSettings();
  return (
    <PageSkeleton id="settings-billing" label="Loading billing">
      <BillingView orgs={orgs} billing={[billing]} usage={scanPricingMode("slice") === "usage" ? { [orgs[0]!.id]: sampleUsageHistory() } : undefined} />
    </PageSkeleton>
  );
}
