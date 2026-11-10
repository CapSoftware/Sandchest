import type { DashboardRepo, scanForUser } from "@sandchest/db";
import { Dig } from "@/components/app/dig";
import { Heat } from "@/components/app/heat";
import { HoverLink, Link } from "@/components/app/hover-link";
import { ScanBill } from "@/components/app/scan-bill";
import { Reveal, ScanClock, ScanFeed, ScanLive, ScanStatus, ScanTrack, type LiveLoop } from "@/components/app/scan-live";
import { ScanWatch } from "@/components/app/scan-watch";
import type { BillView } from "@/lib/bill-view";
import { compactNumber, money, plural, SCAN_KIND_LABEL } from "@/lib/format";
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
 * Whether a scan started fast ran fast, to say so on its page: from its bill, or while it runs, from whether its
 * hunt really runs fast (else from its pricing). Never for a scan not started fast.
 */
export function ranFast(scan: Pick<ScanRow["scan"], "fast" | "stats" | "pricing">, bill?: Pick<BillView, "fast">): boolean {
  if (!scan.fast) return false;
  if (bill) return bill.fast;
  const slice = (scan.stats as { slice?: { fast?: boolean } } | null)?.slice;
  return slice?.fast ?? scan.pricing?.fast === true;
}

/**
 * A scan, drawn from what the page read; its loading state draws it from a sample scan. `again` is the Dig key
 * of a finished deep scan's repo; `next` is the deep scan a running recon is mapping the repo for, and
 * `waitingOn` the recon a queued deep scan waits for. The demo plays `loop` instead of following the scan, and shows
 * its findings as the feed names them. `bill` is the scan's usage bill as a customer sees it, for a scan billed
 * from its usage once the bill is written.
 */
export function ScanView({
  row,
  again,
  next,
  waitingOn,
  loop,
  bill,
}: {
  row: ScanRow;
  again?: { repo: DashboardRepo; plan: OrgPlan };
  next?: string;
  waitingOn?: string;
  loop?: LiveLoop;
  bill?: BillView;
}) {
  const { scan, repo, org, metrics, findings, events } = row;
  const live = ACTIVE.has(scan.status);
  const shown = findings.filter((finding) => finding.confidence !== "low");
  const stats = (scan.stats ?? {}) as { loc?: number; checked?: number; fixed?: number };
  const fast = ranFast(scan, bill);

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
              {fast && " · Fast"}
            </p>
          </div>
          {scan.prNumber !== null && (
            <a className="key key-secondary" href={`https://github.com/${repo.fullName}/pull/${scan.prNumber}`} target="_blank" rel="noreferrer">
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
              <dd>{money(scan.credits)}</dd>
            </div>
          )}
        </dl>

        {bill && <ScanBill bill={bill} />}

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
