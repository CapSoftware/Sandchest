import type { FindingListItem } from "@sandchest/db";
import { AutoSubmitSelect } from "@/components/app/auto-submit";
import { CopyFindings } from "@/components/app/copy-findings";
import { Heat } from "@/components/app/heat";
import { HoverLink, Link } from "@/components/app/hover-link";
import { MorePlaces } from "@/components/app/more-places";
import { When } from "@/components/app/when";
import { SEVERITIES, SEVERITY_LABEL, type Severity } from "@/lib/format";
import { isUuid } from "@/lib/uuid";

type Status = "open" | "fixed" | "dismissed";
const STATUSES: Array<{ id: Status; label: string }> = [
  { id: "open", label: "Open" },
  { id: "fixed", label: "Fixed" },
  { id: "dismissed", label: "Dismissed" },
];

export interface Query {
  status?: string;
  severity?: string;
  repo?: string;
  low?: string;
}

export function parse(query: Query) {
  const status = STATUSES.some((s) => s.id === query.status) ? (query.status as Status) : "open";
  const severities = (query.severity ?? "").split(",").filter((s): s is Severity => (SEVERITIES as string[]).includes(s));
  const repo = isUuid(query.repo) ? query.repo : undefined;
  return { status, severities, repo, low: query.low === "1" };
}

/** A link to these findings with some filters changed. */
function href(current: ReturnType<typeof parse>, change: Partial<ReturnType<typeof parse>>): string {
  const next = { ...current, ...change };
  const params = new URLSearchParams();
  if (next.status !== "open") params.set("status", next.status);
  if (next.severities.length) params.set("severity", next.severities.join(","));
  if (next.repo) params.set("repo", next.repo);
  if (next.low) params.set("low", "1");
  const query = params.toString();
  return query ? `/dashboard/findings?${query}` : "/dashboard/findings";
}

export type FindingsQuery = ReturnType<typeof parse>;

/** The findings list, drawn from what the page read; its loading state draws it from sample data. */
export function FindingsView({ current, list, counts, repos }: { current: FindingsQuery; list: FindingListItem[]; counts: Record<Status, number>; repos: Array<{ id: string; fullName: string }> }) {
  const filtered = current.severities.length > 0 || current.repo !== undefined;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Findings</h1>
        {list.length > 0 && <CopyFindings count={list.length} filters={{ status: current.status, severities: current.severities, repo: current.repo, low: current.low }} />}
      </div>

      <div className="filters">
        <nav className="tabs" aria-label="Status">
          {STATUSES.map((status) => (
            <HoverLink key={status.id} className="tab" href={href(current, { status: status.id })} aria-current={current.status === status.id ? "page" : undefined}>
              {status.label}
              <span className="tab-count">{counts[status.id]}</span>
            </HoverLink>
          ))}
        </nav>
        <div className="filter-set">
          <div className="chips" role="group" aria-label="Severity">
            {SEVERITIES.map((severity) => {
              const on = current.severities.includes(severity);
              const severities = on ? current.severities.filter((s) => s !== severity) : [...current.severities, severity];
              return (
                <HoverLink key={severity} className="chip" href={href(current, { severities })} aria-pressed={on}>
                  {SEVERITY_LABEL[severity]}
                </HoverLink>
              );
            })}
          </div>
          {repos.length > 1 && (
            <form action="/dashboard/findings" className="filter-set">
              {current.status !== "open" && <input type="hidden" name="status" value={current.status} />}
              {current.severities.length > 0 && <input type="hidden" name="severity" value={current.severities.join(",")} />}
              {current.low && <input type="hidden" name="low" value="1" />}
              <label className="sr-only" htmlFor="repo-filter">
                Repository
              </label>
              <AutoSubmitSelect id="repo-filter" name="repo" className="select" defaultValue={current.repo ?? ""}>
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
          <HoverLink className="chip" href={href(current, { low: !current.low })} aria-pressed={current.low}>
            Low confidence
          </HoverLink>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="empty">
          <h2 className="empty-title">{emptyTitle(current.status, filtered)}</h2>
          <p>{emptyBody(current.status, filtered)}</p>
          {filtered && (
            <Link className="key key-secondary" href={href(current, { severities: [], repo: undefined })}>
              <span className="key-face">Clear filters</span>
            </Link>
          )}
        </div>
      ) : (
        <ul className="rows">
          {list.map((finding) => (
            <li key={finding.id} className="row finding-row">
              <HoverLink href={`/dashboard/findings/${finding.id}`}>
                <Heat severity={finding.severity} label />
                <span className="finding-row-title">
                  {finding.title}
                  {finding.confidence === "low" && <span className="flag">low confidence</span>}
                  {finding.stale && <span className="flag">code moved</span>}
                </span>
                <span className="finding-row-when">
                  <When date={finding.lastSeenAt} />
                </span>
                <span className="finding-row-where">
                  {finding.repoFullName}
                  {finding.sink && (
                    <>
                      {" "}
                      <code>
                        {finding.sink.file}:{finding.sink.line}
                      </code>
                    </>
                  )}
                  {finding.prNumber !== null && ` in PR #${finding.prNumber}`}
                  <MorePlaces count={finding.morePlaces} />
                </span>
              </HoverLink>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function emptyTitle(status: Status, filtered: boolean): string {
  if (filtered) return "Nothing matches";
  if (status === "open") return "Nothing buried here";
  return status === "fixed" ? "Nothing fixed yet" : "Nothing dismissed";
}

function emptyBody(status: Status, filtered: boolean): string {
  if (filtered) return "No findings match these filters.";
  if (status === "open") return "No open findings. New ones appear here as pull request reviews and deep scans find them.";
  if (status === "fixed") return "Findings move here when a push removes the attack path, or when you mark them fixed.";
  return "Findings you dismiss move here, with the reason you gave.";
}
