import type { AdvisorySeverity, CveListItem, CveState } from "@sandchest/db";
import { AutoSubmitSelect } from "@/components/app/auto-submit";
import { CheckCves } from "@/components/app/check-cves";
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
  /** Not read yet, but in use or asked for: being read now. */
  queued: number;
  checkedAt: Date | null;
}

export interface UncheckedRepo {
  id: string;
  fullName: string;
  state: "queued" | "unchecked" | "unreachable";
}

/** Not-yet-checked repositories listed before "Show more". */
const UNCHECKED_SHOWN = 8;

/** The CVE directory, drawn from what the page read; its loading state draws it from samples. */
export function CvesView({
  current,
  list,
  counts,
  repos,
  coverage,
  unchecked,
}: {
  current: CvesQuery;
  list: CveListItem[];
  counts: Record<CveState, number>;
  repos: Array<{ id: string; fullName: string }>;
  coverage: Coverage;
  unchecked: UncheckedRepo[];
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

      <Unchecked repos={unchecked} />
    </>
  );
}

/** What isn't covered yet: being read now, or waiting for someone to ask. */
function pending(coverage: Coverage): string {
  const reading = coverage.queued;
  const waiting = coverage.repos - coverage.inventoried - reading;
  const them = (n: number) => (n === 1 ? "it" : "them");
  if (reading > 0) return `${reading} ${reading === 1 ? "is" : "are"} still being read; what affects ${them(reading)} shows up here within minutes.`;
  return `${waiting} ${waiting === 1 ? "isn’t" : "aren’t"} checked yet: check ${them(waiting)} below.`;
}

function CoverageNote({ coverage }: { coverage: Coverage }) {
  if (coverage.repos === 0) return null;
  if (coverage.inventoried === 0) return <>Nothing read yet.</>;
  return (
    <>
      {coverage.inventoried < coverage.repos && `${coverage.inventoried} of ${coverage.repos} repositories checked. `}
      {coverage.checkedAt && (
        <>
          Last full check <When date={coverage.checkedAt} />.
        </>
      )}
    </>
  );
}

/**
 * Repositories never checked. Ones in use are read without asking; any other is read when someone presses
 * Check, so a whole account connected by accident costs nothing until it's wanted.
 */
function Unchecked({ repos }: { repos: UncheckedRepo[] }) {
  if (repos.length === 0) return null;
  const row = (repo: UncheckedRepo) => {
    const [owner, name] = repo.fullName.split("/");
    return (
      <li key={repo.id} className="row cve-unchecked-row">
        <span className="cve-unchecked-name">
          <span className="repo-owner">{owner}/</span>
          {name}
        </span>
        {repo.state === "queued" ? (
          <span className="cve-check-state">
            <span className="blink" aria-hidden="true" /> Reading now
          </span>
        ) : (
          <span className="cve-unchecked-go">
            {repo.state === "unreachable" && <span className="cve-check-state">GitHub couldn’t reach it last time</span>}
            <CheckCves repoId={repo.id} />
          </span>
        )}
      </li>
    );
  };
  return (
    <section className="cve-unchecked" aria-labelledby="cve-unchecked-title">
      <div className="panel-head">
        <h2 id="cve-unchecked-title" className="block-title">
          Not checked yet
        </h2>
        <span className="cve-unchecked-count">{repos.length}</span>
      </div>
      <p className="cve-unchecked-note">Repositories in use are checked on their own. Check any other one whenever you want it covered; it takes about a minute.</p>
      <ul className="rows">{repos.slice(0, UNCHECKED_SHOWN).map(row)}</ul>
      {repos.length > UNCHECKED_SHOWN && (
        <details className="cve-unchecked-more">
          <summary>Show {repos.length - UNCHECKED_SHOWN} more</summary>
          <ul className="rows">{repos.slice(UNCHECKED_SHOWN).map(row)}</ul>
        </details>
      )}
    </section>
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
    return coverage.queued > 0 ? (
      <div className="empty">
        <h2 className="empty-title">Reading your repositories</h2>
        <p>Sandchest is reading what your repositories install. Known vulnerabilities show up here as each one is read, within minutes.</p>
      </div>
    ) : (
      <div className="empty">
        <h2 className="empty-title">Nothing checked yet</h2>
        <p>Repositories are checked on their own once they’re in use: a pull request reviewed, or a deep scan run. Check any of them below now.</p>
      </div>
    );
  }
  const unread = coverage.repos - coverage.inventoried;
  if (current.state === "in_code") {
    return (
      <div className="empty">
        <h2 className="empty-title">{unread > 0 ? "Nothing in your code so far" : "Nothing in your code"}</h2>
        <p>
          {unread > 0 ? `No known vulnerability affects a version your shipped code imports in the ${coverage.inventoried} repositories checked so far. ${pending(coverage)}` : "No known vulnerability affects a version your shipped code imports."}
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
        <h2 className="empty-title">{unread > 0 ? "Nothing installed so far" : "Nothing installed"}</h2>
        <p>{unread > 0 ? `No known vulnerability affects anything installed in the ${coverage.inventoried} repositories checked so far. ${pending(coverage)}` : "No known vulnerability affects anything your repositories install."}</p>
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
