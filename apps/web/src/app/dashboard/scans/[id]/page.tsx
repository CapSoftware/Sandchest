import { scanForUser } from "@sandchest/db";
import type { Metadata } from "next";
import Link from "next/link";
import { HoverLink } from "@/components/app/hover-link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Heat } from "@/components/app/heat";
import { LiveFeed } from "@/components/app/live-feed";
import { When } from "@/components/app/when";
import { compactNumber, duration, plural, SCAN_KIND_LABEL, SCAN_STATUS_LABEL } from "@/lib/format";
import { viewer } from "@/server/access";
import { db } from "@/server/db";

type Params = { params: Promise<{ id: string }> };

const ACTIVE = new Set(["queued", "running", "publishing"]);

const load = cache(async (id: string) => {
  const user = await viewer();
  return /^[0-9a-f-]{36}$/.test(id) ? scanForUser(db(), user.id, id, { events: 1_000 }) : undefined;
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const row = await load((await params).id);
  return { title: row ? `${title(row.scan.kind, row.scan.prNumber)} · Sandchest` : "Scan · Sandchest" };
}

function title(kind: string, prNumber: number | null): string {
  return kind === "pr_review" && prNumber !== null ? `Review of PR #${prNumber}` : (SCAN_KIND_LABEL[kind] ?? "Scan");
}

export default async function ScanPage({ params }: Params) {
  const { id } = await params;
  const row = await load(id);
  if (!row) notFound();
  const { scan, repo, metrics, findings, events } = row;
  const live = ACTIVE.has(scan.status);
  const started = scan.startedAt ?? scan.createdAt;
  // Server-rendered: a running scan shows how long it had run when the page was drawn.
  const elapsed = metrics?.durationMs ?? (scan.finishedAt ?? new Date()).getTime() - started.getTime();
  const shown = findings.filter((finding) => finding.confidence !== "low");
  const stats = (scan.stats ?? {}) as { loc?: number; checked?: number; fixed?: number };

  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link href="/dashboard">Repos</Link>
        <span aria-hidden="true">/</span>
        <Link href={`/dashboard/findings?repo=${repo.id}`}>{repo.fullName}</Link>
      </nav>

      <div className="page-head">
        <div>
          <h1 className="page-title">{title(scan.kind, scan.prNumber)}</h1>
          <p className="page-sub">
            <span className="scan-state" data-status={scan.status}>
              {live && <span className="blink" aria-hidden="true" />}
              {SCAN_STATUS_LABEL[scan.status]}
            </span>
            {live ? ", started " : " "}
            <When date={scan.finishedAt ?? started} /> on <code>{scan.headSha === "HEAD" ? "the default branch" : scan.headSha.slice(0, 7)}</code>
          </p>
        </div>
        {scan.prNumber !== null && (
          <a className="key key-secondary" href={`https://github.com/${repo.fullName}/pull/${scan.prNumber}`} target="_blank" rel="noreferrer">
            <span className="key-face">Open the pull request</span>
          </a>
        )}
      </div>

      {scan.error && <p className="scan-error">{scan.error}</p>}

      <dl className="stats">
        <div className="stat">
          <dt>{live ? "Running for" : "Took"}</dt>
          <dd>{duration(elapsed)}</dd>
        </div>
        {scan.kind === "fix_check" ? (
          <div className="stat">
            <dt>Fixed</dt>
            <dd>{stats.checked !== undefined ? `${stats.fixed ?? 0} of ${stats.checked}` : "…"}</dd>
          </div>
        ) : (
          !live && (
            <div className="stat">
              <dt>Findings</dt>
              <dd>{shown.length}</dd>
            </div>
          )
        )}
        {stats.loc !== undefined && (
          <div className="stat">
            <dt>Lines read</dt>
            <dd>{compactNumber(stats.loc)}</dd>
          </div>
        )}
        {scan.credits > 0 && (
          <div className="stat">
            <dt>Cost</dt>
            <dd>{plural(scan.credits, "credit")}</dd>
          </div>
        )}
      </dl>

      {shown.length > 0 && (
        <section className="block" aria-labelledby="found-title">
          <h2 id="found-title" className="block-title">
            Dug up
          </h2>
          <ul className="rows">
            {shown.map((finding) => (
              <li key={finding.id} className="row finding-row">
                <HoverLink href={`/dashboard/findings/${finding.id}`}>
                  <Heat severity={finding.severity} label />
                  <span className="finding-row-title">
                    {finding.title}
                    {finding.status !== "open" && <span className="flag">{finding.status}</span>}
                  </span>
                  <span className="finding-row-when" />
                  {finding.sink && (
                    <span className="finding-row-where">
                      <code>
                        {finding.sink.file}:{finding.sink.line}
                      </code>
                    </span>
                  )}
                </HoverLink>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="block" aria-labelledby="feed-title">
        <h2 id="feed-title" className="block-title">
          {live ? "Live" : "Log"}
        </h2>
        <LiveFeed
          scanId={scan.id}
          startedAt={started.getTime()}
          live={live}
          initial={events.map((event) => ({ seq: event.seq, type: event.type, message: event.message, at: event.createdAt.getTime() - started.getTime() }))}
        />
      </section>
    </>
  );
}
