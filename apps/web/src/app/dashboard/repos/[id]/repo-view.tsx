import type { DashboardRepo, FindingListItem, ScanListItem } from "@sandchest/db";
import type { ReactNode } from "react";
import { DEEP_SCAN_TIERS } from "@sandchest/billing";
import { Dig } from "@/components/app/dig";
import { Heat } from "@/components/app/heat";
import { HoverLink, Link } from "@/components/app/hover-link";
import { MODE_NOTE } from "@/components/app/pull-rows";
import { RepoSettingsForm } from "@/components/app/repo-settings";
import { ScanRows } from "@/components/app/scan-rows";
import { When } from "@/components/app/when";
import { digState } from "@/lib/dig-state";
import { compactNumber, creditsText, SEVERITIES } from "@/lib/format";
import type { OrgPlan } from "@/server/org-plans";
import "../../../rig.css";

/** Runs shown here; the rest are on the Scans page. */
export const HISTORY = 25;

/**
 * A repository, drawn from what the page read; its loading state draws it from a sample repo. `pulls` is its
 * open pull requests panel, which the page streams in (it asks GitHub) and the loading state draws from samples.
 */
export function RepoView({
  repo,
  plan,
  findings,
  history,
  pulls,
}: {
  repo: DashboardRepo;
  plan: OrgPlan;
  findings: FindingListItem[];
  history: ScanListItem[];
  pulls: ReactNode;
}) {
  const [owner, name] = repo.fullName.split("/");
  const open = SEVERITIES.reduce((sum, s) => sum + repo.open[s], 0);
  const dig = digState(repo);
  // What one scheduled deep scan costs: what Scan again would, or at most the top tier until recon sizes the repo.
  const price = !plan ? null : dig.state === "ready" ? (dig.credits === undefined ? `up to ${creditsText(DEEP_SCAN_TIERS.at(-1)!.credits)}` : creditsText(dig.credits)) : null;

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/dashboard/repos">Repos</Link>
        <span aria-hidden="true">/</span>
        <span>{owner}</span>
      </nav>

      <div className="page-head">
        <div>
          <h1 className="page-title">{name}</h1>
          <p className="page-sub">
            {repo.fullName} · {repo.private ? "private" : "public"} ·{" "}
            <a className="quiet" href={`https://github.com/${repo.fullName}`} target="_blank" rel="noreferrer">
              GitHub
            </a>
          </p>
        </div>
        <Dig repo={repo} plan={plan} />
      </div>

      <dl className="stats">
        <div className="stat">
          <dt>Open findings</dt>
          <dd>{open}</dd>
        </div>
        <div className="stat">
          <dt>Reviews, 30 days</dt>
          <dd>{repo.reviews30d}</dd>
        </div>
        <div className="stat">
          <dt>Last deep scan</dt>
          <dd className="stat-text">{repo.lastDeepScanAt ? <When date={repo.lastDeepScanAt} /> : "Never"}</dd>
        </div>
        <div className="stat">
          <dt>Lines of code</dt>
          <dd>{repo.loc === null ? "–" : compactNumber(repo.loc)}</dd>
        </div>
      </dl>

      <section id="review-settings" className="block review-settings-block" aria-labelledby="settings-title">
        <h2 id="settings-title" className="block-title">
          Reviews and schedule
        </h2>
        <RepoSettingsForm repoId={repo.id} branch={repo.defaultBranch} prReviews={repo.prReviews} schedule={repo.deepScanSchedule} nextDeepScanAt={repo.nextDeepScanAt} price={price} />
      </section>

      <section className="block" aria-labelledby="open-title">
        <div className="panel-head">
          <h2 id="open-title" className="block-title">
            Open findings
          </h2>
          {open > findings.length && (
            <HoverLink href={`/dashboard/findings?repo=${repo.id}`} className="panel-link">
              All {open}
            </HoverLink>
          )}
        </div>
        {findings.length === 0 ? (
          <p className="panel-empty">Nothing open in {name}.</p>
        ) : (
          <ul className="rows">
            {findings.map((finding) => (
              <li key={finding.id} className="row finding-row">
                <HoverLink href={`/dashboard/findings/${finding.id}`}>
                  <Heat severity={finding.severity} label />
                  <span className="finding-row-title">
                    {finding.title}
                    {finding.stale && <span className="flag">code moved</span>}
                  </span>
                  <span className="finding-row-when">
                    <When date={finding.lastSeenAt} />
                  </span>
                  <span className="finding-row-where">
                    {finding.sink && (
                      <code>
                        {finding.sink.file}:{finding.sink.line}
                      </code>
                    )}
                    {finding.prNumber !== null && `${finding.sink ? " " : ""}in PR #${finding.prNumber}`}
                  </span>
                </HoverLink>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="block" aria-labelledby="pulls-title">
        <div className="panel-head">
          <h2 id="pulls-title" className="block-title">
            Pull requests
          </h2>
          <a href="#review-settings" className="panel-link">
            {MODE_NOTE[repo.prReviews]}
          </a>
        </div>
        {pulls}
      </section>

      <section className="block" aria-labelledby="history-title">
        <div className="panel-head">
          <h2 id="history-title" className="block-title">
            Scan history
          </h2>
          {history.length === HISTORY && (
            <HoverLink href={`/dashboard/scans?repo=${repo.id}`} className="panel-link">
              Older scans
            </HoverLink>
          )}
        </div>
        {history.length === 0 ? <p className="panel-empty">No scans yet. Recon maps {name} once its account has a plan.</p> : <ScanRows scans={history} repo={false} />}
      </section>
    </>
  );
}
