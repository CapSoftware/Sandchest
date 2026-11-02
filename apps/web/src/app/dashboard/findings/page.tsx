import { dashboardFindings, findingStatusCounts, visibleRepos, type FindingFilters } from "@sandchest/db";
import type { Metadata } from "next";
import Link from "next/link";
import { HoverLink } from "@/components/app/hover-link";
import { AutoSubmitSelect } from "@/components/app/auto-submit";
import { Heat } from "@/components/app/heat";
import { When } from "@/components/app/when";
import { PageShape } from "@/components/app/skeleton";
import { SEVERITIES, SEVERITY_LABEL, type Severity } from "@/lib/format";
import { viewer } from "@/server/access";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Findings · Sandchest" };

type Status = "open" | "fixed" | "dismissed";
const STATUSES: Array<{ id: Status; label: string }> = [
  { id: "open", label: "Open" },
  { id: "fixed", label: "Fixed" },
  { id: "dismissed", label: "Dismissed" },
];

interface Query {
  status?: string;
  severity?: string;
  repo?: string;
  low?: string;
}

function parse(query: Query) {
  const status = STATUSES.some((s) => s.id === query.status) ? (query.status as Status) : "open";
  const severities = (query.severity ?? "").split(",").filter((s): s is Severity => (SEVERITIES as string[]).includes(s));
  const repo = query.repo && /^[0-9a-f-]{36}$/.test(query.repo) ? query.repo : undefined;
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

export default async function FindingsPage({ searchParams }: { searchParams: Promise<Query> }) {
  const [user, query] = await Promise.all([viewer(), searchParams]);
  const current = parse(query);
  const filters: FindingFilters = { status: current.status, severities: current.severities, repoId: current.repo, includeLowConfidence: current.low };
  const [list, counts, repos] = await Promise.all([dashboardFindings(db(), user.id, filters), findingStatusCounts(db(), user.id, filters), visibleRepos(db(), user.id)]);
  const filtered = current.severities.length > 0 || current.repo !== undefined;

  return (
    <PageShape id="findings">
      <div className="page-head">
        <h1 className="page-title">Findings</h1>
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
                </span>
              </HoverLink>
            </li>
          ))}
        </ul>
      )}
    </PageShape>
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
