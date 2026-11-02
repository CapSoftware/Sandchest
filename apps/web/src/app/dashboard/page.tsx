import { adminOrgs, dashboardRepos, type DashboardRepo } from "@sandchest/db";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { HoverLink } from "@/components/app/hover-link";
import { DigButton } from "@/components/app/dig-button";
import { Heat } from "@/components/app/heat";
import { InstallKey } from "@/components/app/install-key";
import { PlanPicker } from "@/components/app/plan-picker";
import { When } from "@/components/app/when";
import { PageShape } from "@/components/app/skeleton";
import { plural, SCAN_KIND_LABEL, SEVERITIES, timeUntil } from "@/lib/format";
import { ensureAccess, viewer } from "@/server/access";
import { digState } from "@/lib/dig-state";
import { PRICES } from "@/lib/pricing";
import { billingEnabled, pageBilling } from "@/server/billing";
import { DEEP_SCAN_TIERS } from "@sandchest/billing";

/** What an unsized repo holds for a Dig: the top tier. */
const MAX_DEEP_SCAN_CREDITS = DEEP_SCAN_TIERS.at(-1)!.credits;
import { db } from "@/server/db";
import "../rig.css";

/** "Deep scan failed 2 hr. ago". Completed scans need no verb. */
const LAST_SCAN_VERB: Record<string, string> = { queued: "queued", running: "started", publishing: "started", failed: "failed", refused: "refused", cancelled: "cancelled" };

export const metadata: Metadata = { title: "Repos · Sandchest" };

/** What billing allows for an org on this page. Undefined when billing is off. */
type OrgPlan = { planId: string | null; credits: number } | undefined;

export default async function ReposPage({ searchParams }: { searchParams: Promise<{ installation_id?: string; state?: string; plan?: string; recruited?: string }> }) {
  const user = await viewer();
  const params = await searchParams;
  // Back from installing on GitHub: read access again so new repos show at once.
  if (params.installation_id) await ensureAccess(user.id, { force: true });
  // Installed from recruiting: carry on there, on the account just connected.
  if (params.state === "recruit") {
    const installed = Number(params.installation_id);
    const org = Number.isSafeInteger(installed) ? (await adminOrgs(db(), user.id)).find((row) => row.installationId === installed) : undefined;
    redirect(org ? `/dashboard/recruit?org=${org.id}` : "/dashboard/recruit");
  }
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
      <PageShape id="repos">
        <h1 className="page-title">Repos</h1>
        <div className="empty" style={{ marginTop: "2rem" }}>
          <h2 className="empty-title">Nothing to scan yet</h2>
          <p>
            Connect a GitHub account, choose the repositories Sandchest may read, and recruit the hacker who scans
            them. You’ll see each repository here once you can push to it.
          </p>
          <Link href="/dashboard/recruit" className="key key-primary key-large key-glow">
            <span className="key-face">Get started</span>
          </Link>
        </div>
      </PageShape>
    );
  }

  const critical = repos.reduce((sum, repo) => sum + repo.open.critical, 0);
  const open = repos.reduce((sum, repo) => sum + SEVERITIES.reduce((n, s) => n + repo.open[s], 0), 0);
  return (
    <PageShape id="repos">
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
      {params.recruited === "1" && (
        <p className="notice" role="status">
          Your hacker has joined. Open any scan to watch them work.
        </p>
      )}
      {params.plan === "started" && unpaid.length === 0 && (
        <p className="notice" role="status">
          You’re all set. Recon is mapping each repository now, about a minute each; then Deep scan is ready.
        </p>
      )}
      {unpaid.map((repo) => (
        <section key={repo.orgId} className="paywall" aria-labelledby={`plan-${repo.orgId}`}>
          <h2 id={`plan-${repo.orgId}`} className="paywall-title">
            Recruit a hacker for {repo.orgLogin}
          </h2>
          <p className="field-help">
            Sandchest maps each repository and reviews every pull request once {repo.orgLogin} joins: {PRICES.plan} {PRICES.review} Your first deep scan
            is free.
            {!repo.orgAdmin && ` Only an admin of ${repo.orgLogin} can join.`}
          </p>
          {repo.orgAdmin && (
            <Link href={`/dashboard/recruit?org=${repo.orgId}`} className="recruit-cta">
              <span>
                <span className="recruit-cta-title">Recruit {repo.orgLogin}’s hacker</span>
                <span className="recruit-cta-note">Tell them about {repo.orgLogin} and where to look first, give them a name and a look, then load their credits. You’ll watch them work on every scan.</span>
              </span>
              <span className="recruit-cta-go">Start recruiting</span>
            </Link>
          )}
          <details className="recruit-skip">
            <summary>Join without recruiting</summary>
            <PlanPicker orgId={repo.orgId} current={null} admin={repo.orgAdmin} />
          </details>
        </section>
      ))}
      <ul className="rows">
        {repos.map((repo) => (
          <li key={repo.id} className="row">
            <RepoRow repo={repo} plan={plans.get(repo.orgId)} />
          </li>
        ))}
      </ul>
    </PageShape>
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
            Scanning
          </HoverLink>
        </div>
      );
    case "cooling":
      return (
        <div className="repo-dig">
          <span className="repo-dig-note">Scanned recently. Ready {timeUntil(state.retryAt)}.</span>
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
      // An org's first deep scan is free. Otherwise an unsized repo holds the top tier and is charged what it measures.
      if (!plan) return <DigButton repoId={repo.id} note="Whole repository" />; // billing off: nothing to price
      if (repo.freeDig) return <DigButton repoId={repo.id} note="Free: your first deep scan" />;
      if (plan.credits < (state.credits ?? MAX_DEEP_SCAN_CREDITS))
        return (
          <div className="repo-dig">
            <HoverLink href="/dashboard/settings#billing" className="repo-dig-note">
              {state.credits === undefined ? `Needs ${MAX_DEEP_SCAN_CREDITS} credits until sized` : "Out of credits: top up"}
            </HoverLink>
          </div>
        );
      return <DigButton repoId={repo.id} note={state.credits === undefined ? `Up to ${MAX_DEEP_SCAN_CREDITS} credits` : `${state.credits} credits`} />;
  }
}
