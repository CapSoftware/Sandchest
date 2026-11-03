import { PageSkeleton } from "@/components/app/skeleton";
import { sampleFindings, sampleRepos, sampleScans } from "@/lib/samples";
import { billingEnabled } from "@/server/billing";
import { RepoView } from "./repo-view";

/** Shown the instant a link is followed, until the repo arrives: the page's own view, of a sample repo. */
export default function Loading() {
  return (
    <PageSkeleton id="repo" label="Loading repository">
      <RepoView repo={sampleRepos()[0]!} plan={billingEnabled() ? { planId: "standard", credits: 120 } : undefined} findings={sampleFindings(4)} history={sampleScans()} />
    </PageSkeleton>
  );
}
