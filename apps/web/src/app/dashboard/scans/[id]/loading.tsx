import { PageSkeleton } from "@/components/app/skeleton";
import { sampleRepos, sampleScan } from "@/lib/samples";
import { billingEnabled } from "@/server/billing";
import { ScanView } from "./scan-view";

/** Shown the instant a link is followed, until the scan arrives: the page's own view, of a sample deep scan. */
export default function Loading() {
  return (
    <PageSkeleton id="scan" label="Loading scan">
      <ScanView row={sampleScan()} again={{ repo: sampleRepos()[0]!, plan: billingEnabled() ? { planId: "standard", credits: 120 } : undefined }} />
    </PageSkeleton>
  );
}
