import { CREDIT_PACK } from "@sandchest/billing/plans";
import type { OrgPlan } from "@/server/org-plans";
import { PageSkeleton } from "@/components/app/skeleton";
import { scanChoices } from "@/lib/first-scan";
import { sampleFindings, sampleOverview, sampleRepos, sampleScans, SAMPLE_ORG_ID } from "@/lib/samples";
import { billingEnabled } from "@/server/billing";
import { OverviewView } from "./overview-view";

/** Shown the instant a link is followed, until the overview arrives: the page's own view, of a sample account. */
export default function Loading() {
  // An account on the plan, as the page shows one; with billing off, as it shows any.
  const plans = new Map<string, OrgPlan>(billingEnabled() ? [[SAMPLE_ORG_ID, { planId: "standard", credits: 120 * CREDIT_PACK }]] : []);
  const repos = sampleRepos();
  return (
    <PageSkeleton id="overview" label="Loading overview">
      <OverviewView repos={repos} plans={plans} overview={sampleOverview()} attention={sampleFindings(4)} recent={sampleScans(6)} launch={scanChoices(repos, plans, [])} />
    </PageSkeleton>
  );
}
