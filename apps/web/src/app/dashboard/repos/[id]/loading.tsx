import { PageSkeleton } from "@/components/app/skeleton";
import { PullRows } from "@/components/app/pull-rows";
import { sampleFindings, samplePulls, sampleRepos, sampleScans } from "@/lib/samples";
import { billingEnabled } from "@/server/billing";
import { RepoView } from "./repo-view";

/** Shown the instant a link is followed, until the repo arrives: the page's own view, of a sample repo. */
export default function Loading() {
  const repo = sampleRepos()[0]!;
  return (
    <PageSkeleton id="repo" label="Loading repository">
      <RepoView
        repo={repo}
        plan={billingEnabled() ? { planId: "standard", credits: 120 } : undefined}
        findings={sampleFindings(4)}
        history={sampleScans()}
        pulls={<PullRows repoId={repo.id} pulls={samplePulls(3)} mode={repo.prReviews} priced={billingEnabled()} />}
      />
    </PageSkeleton>
  );
}
