import { PageSkeleton } from "@/components/app/skeleton";
import { sampleRepos, sampleScans } from "@/lib/samples";
import { parse, ScansView } from "./scans-view";

/** Shown the instant a link is followed, until the scans arrive: the page's own view, of sample scans. */
export default function Loading() {
  return (
    <PageSkeleton id="scans" label="Loading scans">
      <ScansView current={parse({})} list={sampleScans()} repos={sampleRepos()} />
    </PageSkeleton>
  );
}
