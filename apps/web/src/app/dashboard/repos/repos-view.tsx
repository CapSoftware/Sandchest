import type { DashboardRepo } from "@sandchest/db";
import { HoverLink, Link } from "@/components/app/hover-link";
import { InstallKey } from "@/components/app/install-key";
import { ListFilter } from "@/components/app/list-filter";
import { Tally } from "@/components/app/tally";
import { When } from "@/components/app/when";
import { plural, SCAN_KIND_LABEL, SEVERITIES } from "@/lib/format";

/** Lists longer than this get a filter. */
const FILTER_FROM = 8;

/** "Deep scan failed 2 hr. ago". Completed scans need no verb. */
const LAST_SCAN_VERB: Record<string, string> = { queued: "queued", running: "started", publishing: "started", failed: "failed", refused: "refused", cancelled: "cancelled" };

/** The repos list, drawn from what the page read; its loading state draws it from sample repos. */
export function ReposView({ repos }: { repos: DashboardRepo[] }) {
  const orgs = [...new Map(repos.map((repo) => [repo.orgId, repo.orgLogin])).entries()];
  const open = repos.reduce((sum, repo) => sum + SEVERITIES.reduce((n, s) => n + repo.open[s], 0), 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Repos</h1>
          <p className="page-sub">
            {plural(repos.length, "repository", "repositories")}, {open === 0 ? "nothing open" : plural(open, "open finding")}. Most exposed first.
          </p>
        </div>
        <InstallKey secondary />
      </div>

      {repos.length === 0 ? (
        <div className="empty">
          <h2 className="empty-title">No repositories yet</h2>
          <p>Choose the repositories Sandchest may read on GitHub. Each shows here once you can push to it.</p>
          <Link href="/dashboard/recruit" className="key key-primary">
            <span className="key-face">Get started</span>
          </Link>
        </div>
      ) : (
        <>
          {repos.length > FILTER_FROM && <ListFilter list="repo-list" label="Filter repositories" placeholder="Filter repositories" />}
          <div className="repo-table" role="table" aria-label="Repositories">
            <div className="repo-table-head" role="row">
              <span role="columnheader">Repository</span>
              <span role="columnheader">Open findings</span>
              <span role="columnheader" className="repo-table-num">
                Reviews, 30 days
              </span>
              <span role="columnheader">Last scan</span>
            </div>
            <div id="repo-list" role="rowgroup">
              {repos.map((repo) => (
                <RepoRow key={repo.id} repo={repo} org={orgs.length > 1} />
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function RepoRow({ repo, org }: { repo: DashboardRepo; org: boolean }) {
  const [owner, name] = repo.fullName.split("/");
  return (
    <HoverLink href={`/dashboard/repos/${repo.id}`} className="repo-line" role="row" data-name={repo.fullName.toLowerCase()}>
      <span role="cell" className="repo-line-name">
        {org && <span className="repo-owner">{owner}/</span>}
        <span className="repo-line-repo">{name}</span>
        {!repo.private && <span className="tag">public</span>}
      </span>
      <span role="cell">
        <Tally open={repo.open} />
      </span>
      <span role="cell" className="repo-table-num repo-line-dim">
        {repo.reviews30d || "–"}
      </span>
      <span role="cell" className="repo-line-dim">
        {repo.activeDeepScanId ? (
          <span className="scan-result-live">
            <span className="blink" aria-hidden="true" />
            {repo.activeDeepScanWaitsForRecon ? "Recon mapping, then deep scan" : "Deep scan running"}
          </span>
        ) : repo.lastScan ? (
          <>
            {SCAN_KIND_LABEL[repo.lastScan.kind]} {LAST_SCAN_VERB[repo.lastScan.status] ?? ""} <When date={repo.lastScan.at} />
          </>
        ) : (
          "Not scanned yet"
        )}
      </span>
    </HoverLink>
  );
}
