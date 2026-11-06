"use client";
import { useEffect, useState, type CSSProperties } from "react";
import type { HackerRecord } from "@sandchest/db";
import { HoverLink } from "@/components/app/hover-link";
import { itemLabel, itemWhere, scanName, type FeedItem, type FeedJob } from "@/lib/account-feed";
import { compactNumber } from "@/lib/format";
import { readHacker, type HackerProfile } from "@/lib/hacker";
import { HackerMark } from "./hacker-mark";
import { Keycap } from "./keycap";

/** One of the person's other hackers. */
export interface Crew {
  orgId: string;
  login: string;
  hacker: unknown;
  working: boolean;
}

/** What the hacker is on, in a line: the first job running (and how many more), or that they're free. */
export function nowDoing(jobs: FeedJob[]): string {
  const running = jobs.filter((j) => j.status !== "queued");
  const first = running[0] ?? jobs[0];
  if (!first) return "Off duty. Watching for the next pull request.";
  const verb = first.status === "queued" ? "Waiting to start" : first.kind === "pr_review" ? "Reviewing" : first.kind === "deep" ? "Deep scanning" : first.kind === "recon" ? "Mapping" : "Re-checking";
  const what = first.kind === "pr_review" && first.pr ? `#${first.pr} on ${first.repo}` : first.repo;
  const step = first.status !== "queued" && first.step ? ` · ${first.step}` : "";
  const more = jobs.length > 1 ? ` · ${jobs.length - 1} more on the go` : "";
  return `${verb} ${what}${step}${more}`;
}

/**
 * The account's live feed, in a drawer at the foot of the hacker's page: a
 * handle with the latest thing that happened, and on request (the handle, or
 * L) the whole feed rising over the room, with the jobs running and the
 * hacker's record beside it.
 */
export function FeedDrawer({ open, onToggle, items, jobs, record, login, handle, crew, demo, admin }: { open: boolean; onToggle: () => void; items: FeedItem[]; jobs: FeedJob[]; record: HackerRecord; login: string; handle: string; crew: Crew[]; demo: boolean; admin: boolean }) {
  const now = useNow(open ? 15_000 : 60_000);
  const latest = items.find((item) => item.kind !== "line") ?? items[0];
  const jobsDone = record.jobs.deep + record.jobs.reviews + record.jobs.other;
  return (
    <div className="hq-drawer" data-open={open || undefined}>
      <button type="button" className="hq-handle" aria-expanded={open} aria-controls="hq-feed" onClick={onToggle} data-track="hacker-feed-toggle">
        <span className="hq-handle-chevron" aria-hidden="true">
          <Chevron up={!open} />
        </span>
        <span className="hq-handle-title">Live feed</span>
        {jobs.length > 0 && <span className="hq-handle-count">{jobs.length} running</span>}
        {latest && !open && (
          <span className="hq-handle-latest" key={latest.id}>
            {itemLabel(latest) && (
              <span className="hq-kind" data-kind={latest.kind}>
                {itemLabel(latest)}
              </span>
            )}
            {latest.text}
            <span className="hq-handle-where">{itemWhere(latest)}</span>
          </span>
        )}
        <Keycap>L</Keycap>
      </button>

      <div id="hq-feed" className="hq-sheet" hidden={!open}>
        <section className="hq-feed" aria-label={`What’s going on at ${login}`}>
          {items.length === 0 ? (
            <p className="hq-empty">Nothing yet. The next push, pull request or advisory shows up here the moment it happens.</p>
          ) : (
            <ol className="hq-items">
              {items.map((item) => (
                <li key={item.id} className="hq-item" data-kind={item.kind}>
                  <time className="hq-when" dateTime={new Date(item.at).toISOString()}>
                    {ago(item.at, now)}
                  </time>
                  <span className="hq-kind" data-kind={item.kind} data-severity={item.severity}>
                    {itemLabel(item)}
                  </span>
                  <span className="hq-what">
                    {item.href && !demo ? (
                      <HoverLink href={item.href} className="hq-item-link">
                        {item.text}
                      </HoverLink>
                    ) : (
                      item.text
                    )}
                    <span className="hq-where">
                      {itemWhere(item)}
                      {item.scan && (item.kind === "stage" || item.kind === "line" || item.kind === "finding") ? ` · ${scanName(item.scan.kind, null)}` : ""}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <aside className="hq-side">
          <section aria-labelledby="hq-jobs-title">
            <h2 id="hq-jobs-title" className="hq-side-title">
              On the go
            </h2>
            {jobs.length === 0 ? (
              <p className="hq-empty">Nothing running. {handle} picks up the next pull request the moment it opens.</p>
            ) : (
              <ul className="hq-jobs">
                {jobs.map((job) => {
                  const body = (
                    <>
                      <span className="hq-job-name">
                        {job.repo}
                        {job.pr ? ` #${job.pr}` : ""}
                      </span>
                      <span className="hq-job-step">
                        {job.status === "queued" ? "Waiting for a slot" : `${scanName(job.kind, null).replace(/^./, (c) => c.toUpperCase())} · ${job.step ?? "Starting"}`}
                        {job.found > 0 ? ` · ${job.found} found` : ""}
                      </span>
                      <span className="hq-job-track" style={{ "--done": job.steps ? (job.done + (job.status === "queued" ? 0 : 0.5)) / job.steps : 0 } as CSSProperties} aria-hidden="true" />
                      {job.line && <span className="hq-job-line">{job.line}</span>}
                    </>
                  );
                  return (
                    <li key={job.id} className="hq-job" data-queued={job.status === "queued" || undefined}>
                      {demo ? (
                        <div className="hq-job-body">{body}</div>
                      ) : (
                        <HoverLink href={`/dashboard/scans/${job.id}`} className="hq-job-body">
                          {body}
                        </HoverLink>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="hq-record-title">
            <h2 id="hq-record-title" className="hq-side-title">
              Service record
            </h2>
            <dl className="hq-record">
              <Stat label="Jobs done" value={compactNumber(jobsDone)} />
              <Stat label="Lines read" value={compactNumber(record.lines)} />
              <Stat label="Found" value={compactNumber(record.found)} />
              <Stat label="Fixed" value={compactNumber(record.fixed)} />
            </dl>
          </section>

          {crew.length > 0 && (
            <section aria-labelledby="hq-crew-title">
              <h2 id="hq-crew-title" className="hq-side-title">
                The rest of your crew
              </h2>
              <ul className="hq-crew">
                {crew.map((other) => {
                  const look: HackerProfile = readHacker(other.hacker);
                  return (
                    <li key={other.orgId}>
                      <HoverLink href={`/dashboard/hacker?org=${other.orgId}`} className="hq-crew-row">
                        <HackerMark profile={look} size={24} />
                        <span className="hq-crew-name">{look.handle}</span>
                        <span className="hq-crew-org">{other.login}</span>
                        {other.working && <span className="hq-crew-on" aria-label="On a job" />}
                      </HoverLink>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {!admin && <p className="hq-note">Only an admin of {login} can change how {handle} looks.</p>}
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="hq-record-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * The time now, moving on every `everyMs`: enough for "2m ago" to stay true.
 * Null until the page is in the browser, so the server's HTML and the first
 * render agree (they'd disagree on the minute).
 */
function useNow(everyMs: number): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** "now", "4m", "3h", "2d"; nothing before the page is in the browser. */
function ago(at: number, now: number | null): string {
  if (now === null) return "";
  const s = Math.max(0, (now - at) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

function Chevron({ up }: { up: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true" style={up ? undefined : { transform: "rotate(180deg)" }}>
      <path fill="currentColor" d="M3 1h1v1H3zM2 2h1v1H2zM4 2h1v1H4zM1 3h1v1H1zM5 3h1v1H5zM0 4h1v1H0zM6 4h1v1H6z" />
    </svg>
  );
}
