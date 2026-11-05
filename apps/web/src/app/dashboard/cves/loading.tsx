import { PageSkeleton } from "@/components/app/skeleton";
import { cveDirectory } from "@/lib/cve-samples";
import { sampleRepoId, sampleRepos } from "@/lib/samples";
import { CvesView, parse } from "./cves-view";

/** Shown the instant a link is followed, until the directory arrives: the page's own view, of sample matches. */
export default function Loading() {
  const { list, counts } = cveDirectory(sampleRepoId);
  return (
    <PageSkeleton id="cves" label="Loading CVEs">
      <CvesView current={parse({})} list={list} counts={counts} repos={sampleRepos()} coverage={{ repos: 6, inventoried: 6, queued: 0, checkedAt: new Date(Date.now() - 3 * 3_600_000) }} unchecked={[]} />
    </PageSkeleton>
  );
}
