import { PageSkeleton } from "@/components/app/skeleton";
import { sampleFindings, sampleRepos } from "@/lib/samples";
import { FindingsView, parse } from "./findings-view";

/** Shown the instant a link is followed, until the findings arrive: the page's own view, of sample findings. */
export default function Loading() {
  const list = sampleFindings();
  return (
    <PageSkeleton id="findings" label="Loading findings">
      <FindingsView current={parse({})} list={list} counts={{ open: list.length, fixed: 4, dismissed: 1 }} repos={sampleRepos()} />
    </PageSkeleton>
  );
}
