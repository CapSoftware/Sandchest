import { adminOrgs, orgByInstallation, dashboardFindings, dashboardOverview, dashboardRepos, dashboardScans, lastDeepScanCharges } from "@sandchest/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Link } from "@/components/app/hover-link";
import { PageShape } from "@/components/app/skeleton";
import { safeToken } from "@/lib/analytics";
import { ensureAccess, readAgainOnInstall, viewer } from "@/server/access";
import { track } from "@/server/analytics";
import { db } from "@/server/db";
import { firstScan, scanChoices } from "@/lib/first-scan";
import { installationSettingsUrl, MANY_REPOS } from "@/lib/installation";
import { myHackers } from "@/server/hackers";
import { orgPlans } from "@/server/org-plans";
import { DAYS, OverviewView } from "./overview-view";

export const metadata: Metadata = { title: "Overview · Sandchest" };

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ installation_id?: string; setup_action?: string; state?: string; plan?: string; recruited?: string; later?: string }> }) {
  const user = await viewer();
  const params = await searchParams;
  // Back from installing on GitHub: read access again so new repos show at once.
  if (params.installation_id) {
    if (readAgainOnInstall(params.installation_id, user.accessCheckedAt)) await ensureAccess(user.id, { force: true });
    // The install happened on GitHub; this is where the person and their browser rejoin it.
    const id = Number(params.installation_id);
    const installed = Number.isSafeInteger(id) ? await orgByInstallation(db(), id).catch(() => undefined) : undefined;
    await track("app_install_returned", {
      userId: user.id,
      orgId: installed?.id,
      props: { setup_action: safeToken(params.setup_action, 20) ?? null, state: safeToken(params.state, 20) ?? null, outcome: installed ? "ok" : "unknown_installation" },
    });
  }
  // Installed from recruiting: carry on there, on the account just connected.
  if (params.state === "recruit") {
    const installed = Number(params.installation_id);
    const org = Number.isSafeInteger(installed) ? (await adminOrgs(db(), user.id)).find((row) => row.installationId === installed) : undefined;
    redirect(org ? `/dashboard/recruit?org=${org.id}` : "/dashboard/recruit");
  }
  // The page's three heavy reads start now, alongside the repositories and plans they don't depend on, so the page
  // waits for the slowest of them rather than for each in turn. If a redirect below wins, they're dropped.
  const reads = Promise.all([
    dashboardOverview(db(), user.id, DAYS),
    dashboardFindings(db(), user.id, { severities: ["critical", "high"] }, 5),
    dashboardScans(db(), user.id, {}, 6),
  ]);
  reads.catch(() => {});
  const repos = await dashboardRepos(db(), user.id);
  // Not set up yet: go straight to recruiting, unless they chose to finish it later.
  const later = params.later === "1";
  if (repos.length === 0 && !later) redirect("/dashboard/recruit");

  const plans = await orgPlans(repos);
  const orgs = [...new Map(repos.map((repo) => [repo.orgId, repo])).values()];
  const unpaid = orgs.filter((repo) => plans.get(repo.orgId) && !plans.get(repo.orgId)!.planId);
  // No account has joined yet: recruiting is unfinished, so pick it up there. Not
  // straight back from paying (the plan may not show yet) or when they left it for later.
  const joined = orgs.some((repo) => plans.get(repo.orgId)?.planId);
  const recruitable = unpaid.find((repo) => repo.orgAdmin);
  if (!joined && recruitable && !later && !params.plan && !params.recruited) redirect(`/dashboard/recruit?org=${recruitable.orgId}`);

  if (repos.length === 0) {
    return (
      <PageShape id="overview">
        <h1 className="page-title">Overview</h1>
        <div className="empty" style={{ marginTop: "2rem" }}>
          <h2 className="empty-title">Nothing to scan yet</h2>
          <p>
            Connect a GitHub account, choose the repositories Sandchest may read, and recruit the hacker who scans
            them. Reviews, findings and scans show up here once you can push to a repository.
          </p>
          <Link href="/dashboard/recruit" className="key key-primary key-large key-glow">
            <span className="key-face">Get started</span>
          </Link>
        </div>
      </PageShape>
    );
  }

  const [[overview, attention, recent], hackers, admin, charges] = await Promise.all([
    reads,
    myHackers(user.id).catch(() => []),
    adminOrgs(db(), user.id),
    // What each repository's last deep scan cost, for the launcher's price line. Without it the line still says the most.
    lastDeepScanCharges(db(), repos.map((repo) => repo.id)).catch(() => new Map<string, number>()),
  ]);
  // Accounts this person runs that connected more repositories than anyone needs scanned.
  const crowded = admin.flatMap((org) => {
    const count = repos.filter((repo) => repo.orgId === org.id).length;
    const url = installationSettingsUrl(org);
    return count > MANY_REPOS && url ? [{ orgId: org.id, login: org.login, count, url }] : [];
  });
  return (
    <PageShape id="overview">
      <OverviewView repos={repos} plans={plans} overview={overview} attention={attention} recent={recent} notice={params.recruited === "1" ? "recruited" : params.plan === "started" ? "plan_started" : undefined}
        first={firstScan(repos, plans, hackers)}
        launch={scanChoices(repos, plans, hackers, { charges })}
        crowded={crowded}
      />
    </PageShape>
  );
}
