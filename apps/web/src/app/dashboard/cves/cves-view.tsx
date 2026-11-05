import type { AdvisorySeverity, CveListItem, CveState } from "@sandchest/db";
import { AutoSubmitSelect } from "@/components/app/auto-submit";
import { Heat } from "@/components/app/heat";
import { HoverLink, Link } from "@/components/app/hover-link";
import { When } from "@/components/app/when";
import { CVE_SEVERITIES, CVE_SEVERITY_LABEL, CVE_STATES, whereLine } from "@/lib/cves";
import { isUuid } from "@/lib/uuid";
import "./cves.css";

export interface Query {
  state?: string;
  severity?: string;
  repo?: string;
  q?: string;
}

export function parse(query: Query) {
  const state = CVE_STATES.some((s) => s.id === query.state) ? (query.state as CveState) : "in_code";
  const severities = (query.severity ?? "").split(",").filter((s): s is AdvisorySeverity => (CVE_SEVERITIES as string[]).includes(s));
  const repo = isUuid(query.repo) ? query.repo : undefined;
  const q = (query.q ?? "").trim().slice(0, 200) || undefined;
  return { state, severities, repo, q };
}

export type CvesQuery = ReturnType<typeof parse>;

function href(current: CvesQuery, change: Partial<CvesQuery>): string {
  const next = { ...current, ...change };
  const params = new URLSearchParams();
  if (next.state !== "in_code") params.set("state", next.state);
  if (next.severities.length) params.set("severity", next.severities.join(","));
  if (next.repo) params.set("repo", next.repo);
  if (next.q) params.set("q", next.q);
  const query = params.toString();
  return query ? `/dashboard/cves?${query}` : "/dashboard/cves";
}

export interface Coverage {
  repos: number;
  inventoried: number;
  checkedAt: Date | null;
}

/** The CVE directory, drawn from what the page read; its loading state draws it from samples. */
export function CvesView({
  current,
  list,
  counts,
  repos,
  coverage,
}: {
  current: CvesQuery;
  list: CveListItem[];
  counts: Record<CveState, number>;
  repos: Array<{ id: string; fullName: string }>;
  coverage: Coverage;
}) {
  const filtered = current.severities.length > 0 || current.repo !== undefined || current.q !== undefined;
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">CVEs</h1>
          <p className="page-sub cve-sub">
            Known vulnerabilities in what your repositories install, checked against OSV as advisories are published. <CoverageNote coverage={coverage} />
          </p>
        </div>
        <form action="/dashboard/cves" className="cve-search" role="search">
          {current.state !== "in_code" && <input type="hidden" name="state" value={current.state} />}
          {current.repo && <input type="hidden" name="repo" value={current.repo} />}
          <label className="sr-only" htmlFor="cve-q">
            Search CVEs
          </label>
          <input id="cve-q" className="input list-filter-input cve-search-input" type="search" name="q" defaultValue={current.q ?? ""} placeholder="Search a CVE or package" autoComplete="off" spellCheck={false} />
        </form>
      </div>

      <div className="filters">
        <nav className="tabs" aria-label="Where">
          {CVE_STATES.map((state) => (
            <HoverLink key={state.id} className="tab" href={href(current, { state: state.id })} aria-current={current.state === state.id ? "page" : undefined}>
              {state.label}
              <span className="tab-count">{counts[state.id]}</span>
            </HoverLink>
          ))}
        </nav>
        <div className="filter-set">
          <div className="chips" role="group" aria-label="Severity">
            {CVE_SEVERITIES.map((severity) => {
              const on = current.severities.includes(severity);
              const severities = on ? current.severities.filter((s) => s !== severity) : [...current.severities, severity];
              return (
                <HoverLink key={severity} className="chip" href={href(current, { severities })} aria-pressed={on}>
                  {CVE_SEVERITY_LABEL[severity]}
                </HoverLink>
              );
            })}
          </div>
          {repos.length > 1 && (
            <form action="/dashboard/cves" className="filter-set">
              {current.state !== "in_code" && <input type="hidden" name="state" value={current.state} />}
              {current.severities.length > 0 && <input type="hidden" name="severity" value={current.severities.join(",")} />}
              {current.q && <input type="hidden" name="q" value={current.q} />}
              <label className="sr-only" htmlFor="cve-repo-filter">
                Repository
              </label>
              <AutoSubmitSelect id="cve-repo-filter" name="repo" className="select" defaultValue={current.repo ?? ""}>
                <option value="">All repositories</option>
                {repos.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.fullName}
                  </option>
                ))}
              </AutoSubmitSelect>
              <button type="submit" className="chip no-js-submit">
                Show
              </button>
            </form>
          )}
        </div>
      </div>

      {list.length === 0 ? (
        <Empty current={current} counts={counts} coverage={coverage} filtered={filtered} />
      ) : (
        <ul className="rows">
          {list.map((item) => {
            const where = whereLine(item);
            return (
              <li key={item.key} className="row finding-row cve-row">
                <HoverLink href={`/dashboard/cves/${encodeURIComponent(item.key)}`}>
                  <Heat severity={item.severity} label />
                  <span className="finding-row-title">
                    <span className="cve-key">{item.key}</span>
                    <span className="cve-summary">{item.primary.summary}</span>
                    {item.primary.malicious && <span className="flag cve-flag-hot">malicious package</span>}
                    {item.fresh && <span className="flag cve-flag-new">new</span>}
                  </span>
                  <span className="finding-row-when">
                    <When date={item.firstSeenAt} />
                  </span>
                  <span className="finding-row-where">
                    {where.repo} <code>{where.text}</code>
                    {where.site && (
                      <>
                        {" "}
                        imported at <code>{where.site}</code>
                      </>
                    )}
                    {where.why && `: ${where.why}`}
                    {where.more > 0 && ` and ${where.more} more ${where.more === 1 ? "repository" : "repositories"}`}
                  </span>
                </HoverLink>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function CoverageNote({ coverage }: { coverage: Coverage }) {
  if (coverage.repos === 0) return null;
  if (coverage.inventoried === 0) return <>Nothing read yet.</>;
  const missing = coverage.repos - coverage.inventoried;
  return (
    <>
      {coverage.checkedAt && (
        <>
          Last full check <When date={coverage.checkedAt} />.
        </>
      )}
      {missing > 0 && ` ${missing} of ${coverage.repos} repositories not read yet.`}
    </>
  );
}

function Empty({ current, counts, coverage, filtered }: { current: CvesQuery; counts: Record<CveState, number>; coverage: Coverage; filtered: boolean }) {
  if (filtered) {
    return (
      <div className="empty">
        <h2 className="empty-title">Nothing matches</h2>
        <p>{current.q ? `Nothing in your repositories matches “${current.q}”. A CVE that isn't here doesn't affect a version they install.` : "No CVEs match these filters."}</p>
        <Link className="key key-secondary" href={href(current, { severities: [], repo: undefined, q: undefined })}>
          <span className="key-face">Clear filters</span>
        </Link>
      </div>
    );
  }
  if (coverage.inventoried === 0) {
    return (
      <div className="empty">
        <h2 className="empty-title">Nothing read yet</h2>
        <p>Sandchest reads what each repository installs when it maps or scans it, and again whenever a push changes a lockfile. Known vulnerabilities show up here a few minutes later.</p>
      </div>
    );
  }
  if (current.state === "in_code") {
    return (
      <div className="empty">
        <h2 className="empty-title">Nothing in your code</h2>
        <p>
          No known vulnerability affects a version your shipped code imports.
          {counts.installed > 0 && ` ${counts.installed} affect packages that are installed but not imported by shipped code.`}
        </p>
        {counts.installed > 0 && (
          <Link className="key key-secondary" href={href(current, { state: "installed" })}>
            <span className="key-face">See installed</span>
          </Link>
        )}
      </div>
    );
  }
  if (current.state === "installed") {
    return (
      <div className="empty">
        <h2 className="empty-title">Nothing installed</h2>
        <p>No known vulnerability affects anything your repositories install.</p>
      </div>
    );
  }
  return (
    <div className="empty">
      <h2 className="empty-title">Nothing resolved yet</h2>
      <p>Vulnerabilities move here when an upgrade removes the affected version, or the advisory stops applying to it.</p>
    </div>
  );
}
