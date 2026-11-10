import { PageSkeleton } from "@/components/app/skeleton";
import { scanChoices } from "@/lib/first-scan";
import { sampleRepos } from "@/lib/samples";
import { ReposView } from "./repos-view";

/** Shown the instant a link is followed, until the repos arrive: the page's own view, of sample repos. */
export default function Loading() {
  const repos = sampleRepos();
  return (
    <PageSkeleton id="repos" label="Loading repos">
      <ReposView repos={repos} launch={scanChoices(repos, new Map(), [])} />
    </PageSkeleton>
  );
}
