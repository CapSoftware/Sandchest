import { PageSkeleton } from "@/components/app/skeleton";
import { cveEntry, SAMPLE_CVE_KEY } from "@/lib/cve-samples";
import { sampleRepoId } from "@/lib/samples";
import { CveView } from "./cve-view";

/** Shown the instant a link is followed, until the vulnerability arrives: the page's own view, of a sample. */
export default function Loading() {
  return (
    <PageSkeleton id="cve" label="Loading CVE">
      <CveView row={cveEntry(sampleRepoId, SAMPLE_CVE_KEY)!} />
    </PageSkeleton>
  );
}
