import { CREDIT_PACK } from "@sandchest/billing/plans";
import type { OrgPlan } from "@/server/org-plans";
import { DAYS, OverviewView } from "../dashboard/overview-view";
import { DEMO_HACKER, DEMO_ORG_ID, demoFindings, demoOverview, demoRepos, demoScans } from "@/lib/demo";
import { scanChoices } from "@/lib/first-scan";

/** The demo's overview: the dashboard's, of the made-up account, with its deep scan running. */
export default function DemoOverviewPage() {
  const plans = new Map<string, OrgPlan>([[DEMO_ORG_ID, { planId: "standard", credits: 120 * CREDIT_PACK }]]);
  const repos = demoRepos();
  return (
    <OverviewView
      repos={repos}
      plans={plans}
      overview={demoOverview(DAYS)}
      attention={demoFindings({ severities: ["critical", "high"] }, 5)}
      recent={demoScans({}, 6)}
      launch={scanChoices(repos, plans, [{ orgId: DEMO_ORG_ID, hacker: DEMO_HACKER }])}
    />
  );
}
