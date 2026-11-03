import { PageSkeleton } from "@/components/app/skeleton";
import { sampleRepos } from "@/lib/samples";
import { ReposView } from "./repos-view";

/** Shown the instant a link is followed, until the repos arrive: the page's own view, of sample repos. */
export default function Loading() {
  return (
    <PageSkeleton id="repos" label="Loading repos">
      <ReposView repos={sampleRepos()} />
    </PageSkeleton>
  );
}
