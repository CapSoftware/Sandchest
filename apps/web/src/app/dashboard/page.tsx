import { dashboardRepos, type DashboardRepo } from "@sandchest/db";
import type { Metadata } from "next";
import Link from "next/link";
import { HoverLink } from "@/components/app/hover-link";
import { DigButton } from "@/components/app/dig-button";
import { Heat } from "@/components/app/heat";
import { InstallKey } from "@/components/app/install-key";
import { PlanPicker } from "@/components/app/plan-picker";
import { When } from "@/components/app/when";
import { plural, SCAN_KIND_LABEL, SEVERITIES, timeUntil } from "@/lib/format";
import { ensureAccess, viewer } from "@/server/access";
import { digState } from "@/lib/dig-state";
import { billingEnabled, pageBilling } from "@/server/billing";
import { db } from "@/server/db";

/** "Deep scan failed 2 hr. ago". Completed scans need no verb. */
const LAST_SCAN_VERB: Record<string, string> = { queued: "queued", running: "started", publishing: "started", failed: "failed", refused: "refused", cancelled: "cancelled" };

export const metadata: Metadata = { title: "Repos · Sandchest" };

/** What billing allows for an org on this page. Undefined when billing is off. */
type OrgPlan = { planId: string | null; credits: number } | undefined;

export default async function ReposPage({ searchParams }: { searchParams: Promise<{ installation_id?: string; plan?: string }> }) {
  const user = await viewer();
  const params = await searchParams;
  // Back from installing on GitHub: read access again so new repos show at once.
  if (params.installation_id) await ensureAccess(user.id, { force: true });
  const repos = await dashboardRepos(db(), user.id);

  // Each org's billing, read from Autumn only where the stored copy is missing or old.
  const orgs = [...new Map(repos.map((repo) => [repo.orgId, repo])).values()];
  const plans = new Map<string, OrgPlan>();
  if (billingEnabled()) {
    const rows = await Promise.all(orgs.map((repo) => pageBilling({ id: repo.orgId, githubLogin: repo.orgLogin }, repo.billing)));
    orgs.forEach((repo, i) => plans.set(repo.orgId, { planId: rows[i]?.planId ?? null, credits: rows[i]?.credits ?? 0 }));
  }
  const unpaid = orgs.filter((repo) => plans.get(repo.orgId) && !plans.get(repo.orgId)!.planId);

  if (repos.length === 0) {
    return (
      <>
        <h1 className="page-title">Repos</h1>
        <div className="empty" style={{ marginTop: "2rem" }}>
          <h2 className="empty-title">Nothing to dig into yet</h2>
          <p>
            Install Sandchest on a GitHub account and choose the repositories it may read. You’ll see each one here once
            you can push to it.
          </p>
          <InstallKey />
        </div>
      </>
    );
  }

  const critical = repos.reduce((sum, repo) => sum + repo.open.critical, 0);
  const open = repos.reduce((sum, repo) => sum + SEVERITIES.reduce((n, s) => n + repo.open[s], 0), 0);
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Repos</h1>
          <p className="page-sub">
            {plural(repos.length, "repository", "repositories")}, {open === 0 ? "nothing open" : `${plural(open, "open finding")}`}
            {critical > 0 && `, ${critical} critical`}.
          </p>
        </div>
        <InstallKey secondary />
      </div>
      {params.plan === "started" && unpaid.length === 0 && (
        <p className="notice" role="status">
          You’re all set. Recon is mapping each repository now, about a minute each; then Dig is ready.
        </p>
      )}
      {unpaid.map((repo) => (
        <section key={repo.orgId} className="paywall" aria-labelledby={`plan-${repo.orgId}`}>
          <h2 id={`plan-${repo.orgId}`} className="paywall-title">
            Choose a plan for {repo.orgLogin}
          </h2>
          <p className="field-help">
            Sandchest maps each repository and reviews every pull request once {repo.orgLogin} has a plan. Credits pay for reviews (1–5) and
            deep scans (15–75); recon and fix checks are free.
            {!repo.orgAdmin && ` Only an admin of ${repo.orgLogin} can choose one.`}
          </p>
          <PlanPicker orgId={repo.orgId} current={null} admin={repo.orgAdmin} />
        </section>
      ))}
      <ul className="rows">
        {repos.map((repo) => (
          <li key={repo.id} className="row">
            <RepoRow repo={repo} plan={plans.get(repo.orgId)} />
          </li>
        ))}
      </ul>
    </>
  );
}

function RepoRow({ repo, plan }: { repo: DashboardRepo; plan: OrgPlan }) {
  const [owner, name] = repo.fullName.split("/");
  const counts = SEVERITIES.filter((severity) => repo.open[severity] > 0);
  return (
    <div className="repo">
      <div className="repo-name">
        <HoverLink href={`/dashboard/findings?repo=${repo.id}`}>
          <span className="repo-owner">{owner}/</span>
          {name}
        </HoverLink>
        {repo.private ? null : <span className="tag">public</span>}
      </div>
      <div className="tally">
        {counts.length === 0 ? (
          <span className="tally-clear">Nothing open</span>
        ) : (
          counts.map((severity) => (
            <Link key={severity} href={`/dashboard/findings?repo=${repo.id}&severity=${severity}`} aria-label={`${repo.open[severity]} ${severity}`}>
              <Heat severity={severity} />
              {repo.open[severity]}
            </Link>
          ))
        )}
      </div>
      <div className="repo-scan">
        {repo.lastScan ? (
          <HoverLink href={`/dashboard/scans/${repo.lastScan.id}`}>
            {SCAN_KIND_LABEL[repo.lastScan.kind]} {LAST_SCAN_VERB[repo.lastScan.status] ?? ""} <When date={repo.lastScan.at} />
          </HoverLink>
        ) : (
          "Not scanned yet"
        )}
      </div>
      <Dig repo={repo} plan={plan} />
    </div>
  );
}

function Dig({ repo, plan }: { repo: DashboardRepo; plan: OrgPlan }) {
  const state = digState(repo);
  switch (state.state) {
    case "running":
      return (
        <div className="repo-dig">
          <HoverLink href={`/dashboard/scans/${state.scanId}`} className="digging">
            <span className="blink" aria-hidden="true" />
            Digging
          </HoverLink>
        </div>
      );
    case "cooling":
      return (
        <div className="repo-dig">
          <span className="repo-dig-note">Dug recently. Ready {timeUntil(state.retryAt)}.</span>
        </div>
      );
    case "too_large":
      return (
        <div className="repo-dig">
          <span className="repo-dig-note">Over a million lines: get in touch to scan it.</span>
        </div>
      );
    case "ready":
      if (plan && !plan.planId)
        return (
          <div className="repo-dig">
            <span className="repo-dig-note">Needs a plan</span>
          </div>
        );
      if (plan && plan.credits < (state.credits ?? 15))
        return (
          <div className="repo-dig">
            <HoverLink href="/dashboard/settings#billing" className="repo-dig-note">
              Out of credits: top up
            </HoverLink>
          </div>
        );
      return <DigButton repoId={repo.id} note={state.credits === undefined ? "Full deep scan" : `${state.credits} credits`} />;
  }
}
