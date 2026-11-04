import type { DashboardRepo, FindingListItem, Overview, OverviewWindow, ScanListItem } from "@sandchest/db";
import { ActivityChart, SeverityStrip, Spark } from "@/components/app/charts";
import { Heat } from "@/components/app/heat";
import { HoverLink, Link } from "@/components/app/hover-link";
import { PlanPicker } from "@/components/app/plan-picker";
import { ScanRows } from "@/components/app/scan-rows";
import { Tally } from "@/components/app/tally";
import { compactNumber, plural, SEVERITIES, SEVERITY_LABEL } from "@/lib/format";
import { PRICES } from "@/lib/pricing";
import type { OrgPlan } from "@/server/org-plans";
import "../rig.css";

/** The overview's window, in days. */
export const DAYS = 30;

/** The overview, drawn from what the page read; its loading state draws it from sample data. */
export function OverviewView({
  repos,
  plans,
  overview,
  attention,
  recent,
  notice,
}: {
  repos: DashboardRepo[];
  plans: Map<string, OrgPlan>;
  overview: Overview;
  attention: FindingListItem[];
  recent: ScanListItem[];
  /** Back from recruiting or paying. */
  notice?: "recruited" | "plan_started";
}) {
  const orgs = [...new Map(repos.map((repo) => [repo.orgId, repo])).values()];
  const unpaid = orgs.filter((repo) => plans.get(repo.orgId) && !plans.get(repo.orgId)!.planId);
  const { now, before, open, days } = overview;
  const openTotal = SEVERITIES.reduce((sum, s) => sum + open[s], 0);
  const paid = orgs.filter((repo) => plans.get(repo.orgId)?.planId);
  const credits = paid.reduce((sum, repo) => sum + plans.get(repo.orgId)!.credits, 0);
  const running = repos.filter((repo) => repo.activeDeepScanId);
  const exposed = repos.filter((repo) => SEVERITIES.some((s) => repo.open[s] > 0)).slice(0, 5);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-sub">
            {orgs.map((repo) => repo.orgLogin).join(", ")} · {plural(repos.length, "repository", "repositories")} · last {DAYS} days
          </p>
        </div>
      </div>

      {notice === "recruited" && (
        <p className="notice" role="status">
          Your hacker has joined. Open any scan to watch them work.
        </p>
      )}
      {notice === "plan_started" && unpaid.length === 0 && (
        <p className="notice" role="status">
          You’re all set. Recon is mapping each repository now, about a minute each; then Deep scan is ready.
        </p>
      )}
      {unpaid.map((repo) => (
        <Paywall key={repo.orgId} repo={repo} />
      ))}
      {running.map((repo) => (
        <HoverLink key={repo.id} href={`/dashboard/scans/${repo.activeDeepScanId}`} className="running-strip">
          <span className="blink" aria-hidden="true" />
          {repo.activeDeepScanWaitsForRecon ? (
            <span>
              Deep scan of <strong>{repo.fullName}</strong> starts once recon has mapped it
            </span>
          ) : (
            <span>
              Deep scan of <strong>{repo.fullName}</strong> is running
            </span>
          )}
          <span className="running-strip-go">Watch</span>
        </HoverLink>
      ))}

      <dl className="kpis">
        <Kpi label="Pull requests reviewed" value={now.pullRequests} spark={days.map((d) => d.reviews)} foot={versus(now, before, "pullRequests")} sparkLabel="Reviews per day" />
        <Kpi label="Findings" value={now.found} spark={days.map((d) => d.found)} foot={versus(now, before, "found")} sparkLabel="Findings per day" />
        <Kpi label="Fixed" value={now.fixed} spark={days.map((d) => d.fixed)} foot={versus(now, before, "fixed")} sparkLabel="Fixes per day" />
        {paid.length > 0 ? (
          <div className="kpi">
            <dt>Credits left</dt>
            <dd className="kpi-value">{compactNumber(credits)}</dd>
            <dd className="kpi-foot">
              {now.credits} used in {DAYS} days ·{" "}
              <HoverLink href="/dashboard/settings#billing" className="quiet">
                Top up
              </HoverLink>
            </dd>
          </div>
        ) : (
          <Kpi label="Deep scans" value={now.deepScans} spark={days.map((d) => d.deep)} foot={versus(now, before, "deepScans")} sparkLabel="Deep scans per day" />
        )}
      </dl>

      <div className="overview-grid">
        <section className="panel" aria-labelledby="activity-title">
          <div className="panel-head">
            <h2 id="activity-title" className="block-title">
              Activity
            </h2>
            <HoverLink href="/dashboard/scans" className="panel-link">
              All scans
            </HoverLink>
          </div>
          <ActivityChart days={days} />
        </section>

        <section className="panel" aria-labelledby="open-title">
          <div className="panel-head">
            <h2 id="open-title" className="block-title">
              Open findings
            </h2>
            <HoverLink href="/dashboard/findings" className="panel-link">
              All findings
            </HoverLink>
          </div>
          <p className="open-total">
            <span className="open-total-n">{openTotal}</span> open
          </p>
          <SeverityStrip open={open} />
          <ul className="severity-list">
            {SEVERITIES.map((severity) => (
              <li key={severity}>
                <HoverLink href={`/dashboard/findings?severity=${severity}`}>
                  <span aria-hidden="true">
                    <Heat severity={severity} />
                  </span>
                  <span className="severity-list-name">{SEVERITY_LABEL[severity]}</span>
                  <span className="severity-list-n">{open[severity]}</span>
                </HoverLink>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="overview-grid overview-grid-even">
        <section className="panel" aria-labelledby="attention-title">
          <div className="panel-head">
            <h2 id="attention-title" className="block-title">
              Needs attention
            </h2>
            {attention.length > 0 && (
              <HoverLink href="/dashboard/findings?severity=critical,high" className="panel-link">
                All critical and high
              </HoverLink>
            )}
          </div>
          {attention.length === 0 ? (
            <p className="panel-empty">Nothing critical or high is open.</p>
          ) : (
            <ul className="rows">
              {attention.map((finding) => (
                <li key={finding.id} className="row">
                  <HoverLink href={`/dashboard/findings/${finding.id}`} className="mini-row">
                    <Heat severity={finding.severity} />
                    <span className="mini-row-main">
                      <span className="mini-row-title">{finding.title}</span>
                      <span className="mini-row-sub">{finding.repoFullName}</span>
                    </span>
                  </HoverLink>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel" aria-labelledby="recent-title">
          <div className="panel-head">
            <h2 id="recent-title" className="block-title">
              Recent scans
            </h2>
            <HoverLink href="/dashboard/scans" className="panel-link">
              History
            </HoverLink>
          </div>
          {recent.length === 0 ? <p className="panel-empty">No scans yet. Pull request reviews start with the next pull request.</p> : <ScanRows scans={recent} compact />}
        </section>
      </div>

      <section className="panel" aria-labelledby="exposed-title">
        <div className="panel-head">
          <h2 id="exposed-title" className="block-title">
            Most exposed
          </h2>
          <HoverLink href="/dashboard/repos" className="panel-link">
            All {plural(repos.length, "repository", "repositories")}
          </HoverLink>
        </div>
        {exposed.length === 0 ? (
          <p className="panel-empty">No repository has anything open.</p>
        ) : (
          <ul className="rows">
            {exposed.map((repo) => (
              <li key={repo.id} className="row">
                <HoverLink href={`/dashboard/repos/${repo.id}`} className="mini-row mini-row-repo">
                  <span className="mini-row-title">
                    <span className="repo-owner">{repo.fullName.split("/")[0]}/</span>
                    {repo.fullName.split("/")[1]}
                  </span>
                  <Tally open={repo.open} />
                </HoverLink>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Kpi({ label, value, spark, foot, sparkLabel }: { label: string; value: number; spark: number[]; foot: string; sparkLabel: string }) {
  return (
    <div className="kpi">
      <dt>{label}</dt>
      <dd className="kpi-value">{compactNumber(value)}</dd>
      <dd className="kpi-spark">
        <Spark values={spark} label={sparkLabel} />
      </dd>
      <dd className="kpi-foot">{foot}</dd>
    </div>
  );
}

/** "11 the 30 days before". */
function versus(now: OverviewWindow, before: OverviewWindow, key: keyof OverviewWindow): string {
  if (now[key] === 0 && before[key] === 0) return "None yet";
  return `${compactNumber(before[key])} the ${DAYS} days before`;
}

function Paywall({ repo }: { repo: DashboardRepo }) {
  return (
    <section className="paywall" aria-labelledby={`plan-${repo.orgId}`}>
      <h2 id={`plan-${repo.orgId}`} className="paywall-title">
        Recruit a hacker for {repo.orgLogin}
      </h2>
      <p className="field-help">
        Sandchest maps each repository and reviews every pull request once {repo.orgLogin} joins: {PRICES.plan} {PRICES.review} Your first deep scan is free.
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
        <summary data-track="recruit-skip-open">Join without recruiting</summary>
        <PlanPicker orgId={repo.orgId} current={null} admin={repo.orgAdmin} />
      </details>
    </section>
  );
}
