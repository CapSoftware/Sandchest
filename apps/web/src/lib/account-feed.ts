/**
 * The hacker's live feed of an account: what's going on, as items to show
 * and the jobs still running. Pure, and shared by the server (which turns
 * the database's rows into items), the page (which keeps a bounded list of
 * them), the hacker's screen and the demo (which makes them up).
 */
import type { LiveCve, LiveFindingChange, LiveHistory, LiveLine, LiveScan } from "@sandchest/db";
import { SCAN_KIND_LABEL } from "./format";
import { stepOf, trackOf } from "./scan-progress";

export type FeedKind = "queued" | "started" | "done" | "failed" | "stage" | "line" | "finding" | "fixed" | "dismissed" | "reopened" | "cve";

export interface FeedItem {
  /** Stable across reads and server instances, so a reconnect never shows one twice. */
  id: string;
  /** When it happened, epoch ms. */
  at: number;
  kind: FeedKind;
  repoId: string;
  repo: string;
  text: string;
  /** The scan it came from: its id, kind and pull request. */
  scan?: { id: string; kind: string; pr: number | null };
  severity?: string;
  href?: string;
}

/** A scan still going, as the feed shows it: where it is and its latest line. */
export interface FeedJob {
  id: string;
  repoId: string;
  repo: string;
  kind: string;
  pr: number | null;
  status: string;
  /** When it started (or was queued), epoch ms. */
  since: number;
  /** The step it's on, from its track. */
  step: string | null;
  steps: number;
  done: number;
  line: string | null;
  found: number;
}

export const ACTIVE = new Set(["queued", "running", "publishing"]);
const ENDED_BADLY = new Set(["failed", "cancelled", "refused"]);

/** "PR review of #42", "deep scan", "recon": a scan, in words. */
export function scanName(kind: string, pr: number | null): string {
  const name = (SCAN_KIND_LABEL[kind] ?? kind).toLowerCase().replace("pr review", "review");
  return pr ? `${name} of #${pr}` : name;
}

const scanRef = (scan: Pick<LiveScan, "id" | "kind" | "prNumber">) => ({ id: scan.id, kind: scan.kind, pr: scan.prNumber });
const time = (value: string | null | undefined) => (value ? Date.parse(value) : Date.now());

/**
 * A scan arriving, starting or ending, as an item: none for a scan still
 * where it was. The text says what happened; which scan it was rides along
 * in `scan`, for the feed's label and the line under it.
 */
export function scanItem(scan: LiveScan, was: string | null): FeedItem | null {
  if (scan.status === was) return null;
  const base = { repoId: scan.repoId, repo: scan.repo, scan: scanRef(scan), href: `/dashboard/scans/${scan.id}` };
  if (scan.status === "queued") return { ...base, id: `s:${scan.id}:queued`, at: time(scan.createdAt), kind: "queued", text: "Queued, waiting for a free slot" };
  if ((scan.status === "running" || scan.status === "publishing") && (was === null || was === "queued"))
    return { ...base, id: `s:${scan.id}:started`, at: time(scan.startedAt), kind: "started", text: "Started" };
  if (scan.status === "completed") {
    const found = scan.found ?? 0;
    return { ...base, id: `s:${scan.id}:done`, at: time(scan.finishedAt), kind: "done", text: found === 0 ? "Done: nothing exploitable" : `Done: ${found === 1 ? "1 finding" : `${found} findings`}` };
  }
  if (ENDED_BADLY.has(scan.status))
    return { ...base, id: `s:${scan.id}:${scan.status}`, at: time(scan.finishedAt), kind: "failed", text: scan.status === "refused" ? "Couldn’t start" : scan.status === "cancelled" ? "Stopped" : "Failed" };
  return null;
}

/** What the feed calls an item, beside its text: the kind of scan it's part of, or what happened. Empty for a scan's own lines. */
export function itemLabel(item: FeedItem): string {
  switch (item.kind) {
    case "queued":
    case "started":
    case "done":
    case "failed":
      return item.scan ? (SCAN_KIND_LABEL[item.scan.kind] ?? item.scan.kind) : "Scan";
    case "finding":
      return "Found";
    case "fixed":
      return "Fixed";
    case "dismissed":
      return "Dismissed";
    case "reopened":
      return "Reopened";
    case "cve":
      return "CVE";
    default:
      return "";
  }
}

/** Where an item happened, under its text: the repository, and the pull request if there is one. */
export function itemWhere(item: FeedItem): string {
  return item.scan?.pr ? `${item.repo} #${item.scan.pr}` : item.repo;
}

/** A progress line of a scan, as an item. */
export function lineItem(line: LiveLine, scan: Pick<LiveScan, "id" | "kind" | "prNumber" | "repoId" | "repo">): FeedItem {
  const kind: FeedKind = line.type === "finding" ? "finding" : line.type.startsWith("stage:") ? "stage" : "line";
  return { id: `l:${line.id}`, at: time(line.at), kind, repoId: scan.repoId, repo: scan.repo, text: line.message, scan: scanRef(scan), href: `/dashboard/scans/${scan.id}` };
}

export function changeItem(change: LiveFindingChange): FeedItem {
  return { id: `f:${change.id}`, at: time(change.at), kind: change.type, repoId: change.repoId, repo: change.repo, text: change.title, severity: change.severity, href: `/dashboard/findings/${change.findingId}` };
}

export function cveItem(cve: LiveCve): FeedItem {
  return {
    id: `c:${cve.repoId}:${cve.advisoryId}:${cve.name}@${cve.version}`,
    at: time(cve.at),
    kind: "cve",
    repoId: cve.repoId,
    repo: cve.repo,
    text: `${cve.vuln} in ${cve.name} ${cve.version}: ${cve.summary}`,
    severity: cve.severity,
    href: `/dashboard/cves/${encodeURIComponent(cve.vuln)}`,
  };
}

/** A running scan as a job, from what's known of it and its lines so far (oldest first). */
export function jobOf(scan: LiveScan, types: readonly string[], last: string | null, found: number): FeedJob {
  const track = trackOf(scan.kind, types);
  let reached = -1;
  for (const type of types) {
    const step = stepOf(type);
    const at = track.findIndex((s) => s.key === step);
    if (at > reached) reached = at;
  }
  return {
    id: scan.id,
    repoId: scan.repoId,
    repo: scan.repo,
    kind: scan.kind,
    pr: scan.prNumber,
    status: scan.status,
    since: time(scan.status === "queued" ? scan.createdAt : (scan.startedAt ?? scan.createdAt)),
    step: reached >= 0 ? (track[reached]?.label ?? null) : null,
    steps: track.length,
    done: Math.max(0, reached),
    line: last,
    found,
  };
}

/** The feed as the page opens: items newest first, and the jobs running. */
export function fromHistory(history: LiveHistory): { items: FeedItem[]; jobs: FeedJob[] } {
  const scans = new Map(history.scans.map((s) => [s.id, s]));
  const items: FeedItem[] = [];
  for (const scan of history.scans) {
    // Its arrival, and its ending if it has.
    if (scan.status !== "queued") {
      const started = scanItem({ ...scan, status: "running" }, "queued");
      if (started) items.push(started);
    } else items.push(scanItem(scan, null)!);
    if (!ACTIVE.has(scan.status)) {
      const ended = scanItem(scan, "running");
      if (ended) items.push(ended);
    }
  }
  for (const line of history.lines) {
    const scan = scans.get(line.scanId);
    if (scan) items.push(lineItem(line, scan));
  }
  items.push(...history.changes.map(changeItem), ...history.cves.map(cveItem));
  const jobs = history.scans
    .filter((s) => ACTIVE.has(s.status))
    .map((scan) => {
      const lines = history.lines.filter((l) => l.scanId === scan.id).sort((a, b) => a.id - b.id);
      const last = lines.filter((l) => !l.type.startsWith("stage:")).at(-1) ?? lines.at(-1);
      return jobOf(scan, lines.map((l) => l.type), last?.message ?? null, lines.filter((l) => l.type === "finding").length);
    });
  return { items: dedupe(items).sort((a, b) => b.at - a.at).slice(0, FEED_KEEP), jobs };
}

/** How many items the page keeps: plenty to scroll, and the same however long it's open. */
export const FEED_KEEP = 150;

function dedupe(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)));
}

/**
 * New items into the feed (newest first, at most FEED_KEEP), skipping any it
 * already has. Returns the same list when nothing is new, so nothing redraws.
 */
export function addItems(feed: FeedItem[], incoming: FeedItem[]): FeedItem[] {
  if (incoming.length === 0) return feed;
  const have = new Set(feed.map((item) => item.id));
  const fresh = incoming.filter((item) => !have.has(item.id) && (have.add(item.id), true));
  if (fresh.length === 0) return feed;
  return [...fresh, ...feed].sort((a, b) => b.at - a.at).slice(0, FEED_KEEP);
}
