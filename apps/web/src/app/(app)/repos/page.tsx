import { dashboardRepos, type DashboardRepo } from "@sandchest/db";
import type { Metadata } from "next";
import Link from "next/link";
import { DigButton } from "@/components/app/dig-button";
import { Heat } from "@/components/app/heat";
import { InstallKey } from "@/components/app/install-key";
import { When } from "@/components/app/when";
import { plural, SCAN_KIND_LABEL, SEVERITIES, timeUntil } from "@/lib/format";
import { ensureAccess, viewer } from "@/server/access";
import { digState } from "@/server/dig";
import { db } from "@/server/services";

/** "Deep scan failed 2 hr. ago". Completed scans need no verb. */
const LAST_SCAN_VERB: Record<string, string> = { queued: "queued", running: "started", publishing: "started", failed: "failed", refused: "refused", cancelled: "cancelled" };

export const metadata: Metadata = { title: "Repos · Sandchest" };

export default async function ReposPage({ searchParams }: { searchParams: Promise<{ installation_id?: string }> }) {
  const user = await viewer();
  // Back from installing on GitHub: read access again so new repos show at once.
  if ((await searchParams).installation_id) await ensureAccess(user.id, { force: true });
  const repos = await dashboardRepos(db(), user.id);

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
      <ul className="rows">
        {repos.map((repo) => (
          <li key={repo.id} className="row">
            <RepoRow repo={repo} />
          </li>
        ))}
      </ul>
    </>
  );
}

function RepoRow({ repo }: { repo: DashboardRepo }) {
  const [owner, name] = repo.fullName.split("/");
  const counts = SEVERITIES.filter((severity) => repo.open[severity] > 0);
  return (
    <div className="repo">
      <div className="repo-name">
        <Link href={`/findings?repo=${repo.id}`}>
          <span className="repo-owner">{owner}/</span>
          {name}
        </Link>
        {repo.private ? null : <span className="tag">public</span>}
      </div>
      <div className="tally">
        {counts.length === 0 ? (
          <span className="tally-clear">Nothing open</span>
        ) : (
          counts.map((severity) => (
            <Link key={severity} href={`/findings?repo=${repo.id}&severity=${severity}`} aria-label={`${repo.open[severity]} ${severity}`}>
              <Heat severity={severity} />
              {repo.open[severity]}
            </Link>
          ))
        )}
      </div>
      <div className="repo-scan">
        {repo.lastScan ? (
          <Link href={`/scans/${repo.lastScan.id}`}>
            {SCAN_KIND_LABEL[repo.lastScan.kind]} {LAST_SCAN_VERB[repo.lastScan.status] ?? ""} <When date={repo.lastScan.at} />
          </Link>
        ) : (
          "Not scanned yet"
        )}
      </div>
      <Dig repo={repo} />
    </div>
  );
}

function Dig({ repo }: { repo: DashboardRepo }) {
  const state = digState(repo);
  switch (state.state) {
    case "running":
      return (
        <div className="repo-dig">
          <Link href={`/scans/${state.scanId}`} className="digging">
            <span className="blink" aria-hidden="true" />
            Digging
          </Link>
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
      return <DigButton repoId={repo.id} note={state.credits === undefined ? "Full deep scan" : `${state.credits} credits`} />;
  }
}
