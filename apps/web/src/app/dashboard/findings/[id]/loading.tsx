import { PageSkeleton } from "@/components/app/skeleton";
import { sampleFinding } from "@/lib/samples";
import { FindingView } from "./finding-view";

/** Shown the instant a link is followed, until the finding arrives: the page's own view, of a sample finding. */
export default function Loading() {
  return (
    <PageSkeleton id="finding" label="Loading finding">
      <FindingView row={sampleFinding()} />
    </PageSkeleton>
  );
}
