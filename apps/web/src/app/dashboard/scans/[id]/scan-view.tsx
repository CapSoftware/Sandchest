import type { DashboardRepo, scanForUser } from "@sandchest/db";
import { Dig } from "@/components/app/dig";
import { Heat } from "@/components/app/heat";
import { HoverLink, Link } from "@/components/app/hover-link";
import { Reveal, ScanClock, ScanFeed, ScanLive, ScanStatus, ScanTrack, type LiveLoop } from "@/components/app/scan-live";
import { ScanWatch } from "@/components/app/scan-watch";
import { compactNumber, plural, repoUrl, SCAN_KIND_LABEL } from "@/lib/format";
import { forgejoWebUrl } from "@/server/forgejo";
import { readHacker } from "@/lib/hacker";
import type { OrgPlan } from "@/server/org-plans";
import "../../../rig.css";

/** A scan as the page reads it: the run, its repository and org, what it found and its feed. */
export type ScanRow = NonNullable<Awaited<ReturnType<typeof scanForUser>>>;

export const ACTIVE = new Set(["queued", "running", "publishing"]);

export function title(kind: string, prNumber: number | null): string {
  return kind === "pr_review" && prNumber !== null ? `Review of PR #${prNumber}` : (SCAN_KIND_LABEL[kind] ?? "Scan");
}

/**
 * A scan, drawn from what the page read; its loading state draws it from a sample scan. `again` is the Dig key
 * of a finished deep scan's repo; `next` is the deep scan a running recon is mapping the repo for, and
 * `waitingOn` the recon a queued deep scan waits for. The demo plays `loop` instead of following the scan, and shows
 * its findings as the feed names them.
 */
export function ScanView({ row, again, next, waitingOn, loop }: { row: ScanRow; again?: { repo: DashboardRepo; plan: OrgPlan }; next?: string; waitingOn?: string; loop?: LiveLoop }) {
  const { scan, repo, org, metrics, findings, events } = row;
  const live = ACTIVE.has(scan.status);
  const shown = findings.filter((finding) => finding.confidence !== "low");
  const stats = (scan.stats ?? {}) as { loc?: number; checked?: number; fixed?: number };

  const initial = {
    kind: scan.kind,
    status: scan.status,
    createdAt: scan.createdAt.getTime(),
    startedAt: scan.startedAt?.getTime() ?? null,
    finishedAt: scan.finishedAt?.getTime() ?? null,
    durationMs: metrics?.durationMs ?? null,
    renderedAt: Date.now(),
    events: events.map((event) => ({ seq: event.seq, type: event.type, message: event.message, at: event.createdAt.getTime() })),
  };

  return (
    <>
      {/* Keyed by status: when the scan ends and the page refreshes, the view starts again from the
          finished scan (its end time and measured duration) instead of keeping what it followed live. */}
      <ScanLive key={scan.status} scanId={scan.id} initial={initial} loop={loop}>
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href="/dashboard/scans">Scans</Link>
          <span aria-hidden="true">/</span>
          <Link href={`/dashboard/repos/${repo.id}`}>{repo.fullName}</Link>
        </nav>

        <div className="page-head">
          <div>
            <h1 className="page-title">{title(scan.kind, scan.prNumber)}</h1>
            <p className="page-sub">
              <ScanStatus /> on <code>{scan.headSha === "HEAD" ? "the default branch" : scan.headSha.slice(0, 7)}</code>
            </p>
          </div>
          {scan.prNumber !== null && (
            <a className="key key-secondary" href={repoUrl(repo.fullName, forgejoWebUrl(repo.provider), scan.prNumber)} target="_blank" rel="noreferrer">
              <span className="key-face">Open the pull request</span>
            </a>
          )}
          {again && <Dig repo={again.repo} plan={again.plan} />}
        </div>

        {scan.error && <p className="scan-error">{scan.error}</p>}

        {next && (
          <HoverLink href={`/dashboard/scans/${next}`} className="running-strip">
            <span className="blink" aria-hidden="true" />
            <span>
              Recon maps <strong>{repo.fullName}</strong> first, usually in under a minute. The deep scan starts from this map.
            </span>
            <span className="running-strip-go">Watch the deep scan</span>
          </HoverLink>
        )}
        {waitingOn && (
          <HoverLink href={`/dashboard/scans/${waitingOn}`} className="running-strip">
            <span className="blink" aria-hidden="true" />
            <span>
              Recon is mapping <strong>{repo.fullName}</strong> first, usually in under a minute. This deep scan starts from that map.
            </span>
            <span className="running-strip-go">Watch recon</span>
          </HoverLink>
        )}

        <ScanWatch profile={readHacker(org.hacker)} repo={repo.fullName} findings={shown.length} hackerHref={`/dashboard/hacker?org=${scan.orgId}`} />

        <dl className="stats">
          <ScanClock />
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
          {/* What was charged, once it was: a free deep scan, or a scan still running, shows no cost. */}
          {scan.billing === "charged" && scan.credits > 0 && (
            <div className="stat">
              <dt>Cost</dt>
              <dd>{plural(scan.credits, "credit")}</dd>
            </div>
          )}
        </dl>

        {shown.length > 0 && (
          <Reveal>
            <section className="block" aria-labelledby="found-title">
              <h2 id="found-title" className="block-title">
                Found
              </h2>
              <ul className="rows">
                {shown.map((finding, i) => (
                  <Reveal key={finding.id} at={i}>
                    <li className="row finding-row">
                      <HoverLink href={`/dashboard/findings/${finding.id}`}>
                        <Heat severity={finding.severity} label />
                        <span className="finding-row-title">{finding.title}</span>
                        <span className="finding-row-when">
                          {(finding.status === "fixed" || finding.status === "dismissed") && (
                            <span className="status status-badge" data-status={finding.status}>
                              {finding.status === "fixed" ? "Fixed" : "Dismissed"}
                            </span>
                          )}
                        </span>
                        {finding.sink && (
                          <span className="finding-row-where">
                            <code>
                              {finding.sink.file}:{finding.sink.line}
                            </code>
                          </span>
                        )}
                      </HoverLink>
                    </li>
                  </Reveal>
                ))}
              </ul>
            </section>
          </Reveal>
        )}

        <section className="block" aria-labelledby="feed-title">
          <h2 id="feed-title" className="block-title">
            {live ? "Live" : "Log"}
          </h2>
          <ScanTrack />
          <ScanFeed />
        </section>
      </ScanLive>
    </>
  );
}
