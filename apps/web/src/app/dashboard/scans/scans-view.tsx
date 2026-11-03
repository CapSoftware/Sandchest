import type { ScanFilters, ScanListItem } from "@sandchest/db";
import { AutoSubmitSelect } from "@/components/app/auto-submit";
import { HoverLink, Link } from "@/components/app/hover-link";
import { ScanRows } from "@/components/app/scan-rows";
import { isUuid } from "@/lib/uuid";

/** Runs on a page. */
export const PAGE = 50;

type Kind = NonNullable<ScanFilters["kind"]>;
const KINDS: Array<{ id: Kind | undefined; label: string }> = [
  { id: undefined, label: "All" },
  { id: "pr_review", label: "PR reviews" },
  { id: "deep", label: "Deep scans" },
  { id: "fix_check", label: "Fix checks" },
  { id: "recon", label: "Recon" },
];

export interface Query {
  kind?: string;
  repo?: string;
  before?: string;
}

export function parse(query: Query) {
  const kind = KINDS.find((k) => k.id !== undefined && k.id === query.kind)?.id;
  const repo = isUuid(query.repo) ? query.repo : undefined;
  const before = query.before && !Number.isNaN(Date.parse(query.before)) ? new Date(query.before) : undefined;
  return { kind, repo, before };
}

/** A link to these scans with some filters changed. Changing a filter starts again from the newest. */
function href(current: ReturnType<typeof parse>, change: Partial<ReturnType<typeof parse>>): string {
  const next = { ...current, before: undefined, ...change };
  const params = new URLSearchParams();
  if (next.kind) params.set("kind", next.kind);
  if (next.repo) params.set("repo", next.repo);
  if (next.before) params.set("before", next.before.toISOString());
  const query = params.toString();
  return query ? `/dashboard/scans?${query}` : "/dashboard/scans";
}

/** The scans list, drawn from what the page read; its loading state draws it from sample scans. */
export function ScansView({ current, list, repos }: { current: ReturnType<typeof parse>; list: ScanListItem[]; repos: Array<{ id: string; fullName: string }> }) {
  const filtered = current.kind !== undefined || current.repo !== undefined;
  const last = list.at(-1);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Scans</h1>
          <p className="page-sub">Every review, deep scan, fix check and recon, newest first. Open one to see what it read and found.</p>
        </div>
      </div>

      <div className="filters">
        <nav className="tabs" aria-label="Kind">
          {KINDS.map((kind) => (
            <HoverLink key={kind.label} className="tab" href={href(current, { kind: kind.id })} aria-current={current.kind === kind.id ? "page" : undefined}>
              {kind.label}
            </HoverLink>
          ))}
        </nav>
        {repos.length > 1 && (
          <form action="/dashboard/scans" className="filter-set">
            {current.kind && <input type="hidden" name="kind" value={current.kind} />}
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
      </div>

      {list.length === 0 ? (
        <div className="empty">
          <h2 className="empty-title">{current.before ? "Nothing older" : filtered ? "Nothing matches" : "No scans yet"}</h2>
          <p>{current.before ? "These are all the scans there are." : filtered ? "No scans match these filters." : "Pull request reviews start with the next pull request. Start a deep scan from any repository."}</p>
          {(filtered || current.before) && (
            <Link className="key key-secondary" href="/dashboard/scans">
              <span className="key-face">Show the newest</span>
            </Link>
          )}
        </div>
      ) : (
        <>
          <ScanRows scans={list} repo={!current.repo} />
          <nav className="pager" aria-label="Pages">
            {current.before && (
              <HoverLink href={href(current, {})} className="chip">
                Newest
              </HoverLink>
            )}
            {list.length === PAGE && last && (
              <HoverLink href={href(current, { before: last.createdAt })} className="chip">
                Older
              </HoverLink>
            )}
          </nav>
        </>
      )}
    </>
  );
}
