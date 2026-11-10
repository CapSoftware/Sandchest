import type { DashboardRepo } from "@sandchest/db";
import { billingEnabled, pageBilling } from "./billing";
import { deepScanQuote, type UsageQuote } from "./usage-quote";

/**
 * What billing allows for an org on a dashboard page. Undefined when billing is off. `usage` is set only for an
 * account whose deep scans are billed from their usage: the most one holds, and a fast one where it is offered.
 */
export type OrgPlan = { planId: string | null; credits: number; usage?: UsageQuote } | undefined;

/** Each org's billing, read from Autumn only where the stored copy is missing or old. */
export async function orgPlans(repos: DashboardRepo[]): Promise<Map<string, OrgPlan>> {
  const orgs = [...new Map(repos.map((repo) => [repo.orgId, repo])).values()];
  const plans = new Map<string, OrgPlan>();
  if (!billingEnabled()) return plans;
  const rows = await Promise.all(orgs.map((repo) => pageBilling({ id: repo.orgId, githubLogin: repo.orgLogin }, repo.billing)));
  orgs.forEach((repo, i) => {
    const usage = deepScanQuote(repo.orgLogin);
    plans.set(repo.orgId, { planId: rows[i]?.planId ?? null, credits: rows[i]?.credits ?? 0, ...(usage && { usage }) });
  });
  return plans;
}
