/**
 * What the landing page's crawl shows: the newest security advisories
 * published to OSV, and the newest findings Sandchest has made. Advisories
 * are public records. Findings are reduced to their severity, their kind and
 * the day they were found, never anything that says whose code they are in.
 * One copy for everyone, rebuilt at most every ten minutes.
 */
import { recentFindingClasses } from "@sandchest/db";
import { CATEGORIES, SEVERITIES } from "@sandchest/engine/schema";
import { unstable_cache } from "next/cache";
import { categoryLabel, type Severity } from "@/lib/format";
import { db } from "./db";

export interface FeedAdvisory {
  kind: "advisory";
  /** The CVE ID when there is one, else the GitHub advisory ID. */
  id: string;
  summary: string;
  severity: Severity | null;
  ecosystem: string;
  package: string;
  /** When it was published, RFC 3339. */
  published: string;
  url: string;
}

export interface FeedFinding {
  kind: "finding";
  severity: Severity;
  /** The kind of hole, in words: "SQL injection". */
  title: string;
  /** Which day it was found, in words: "today", "yesterday", "3 days ago". */
  found: string;
}

export interface Feed {
  advisories: FeedAdvisory[];
  findings: FeedFinding[];
}

/** How long one copy of the feed is shown to everyone, in seconds. */
export const FEED_TTL_S = 600;

const BUCKET = "https://osv-vulnerabilities.storage.googleapis.com";
/** The ecosystems most code installs from. Each has its own feed of changed records, newest first. */
const ECOSYSTEMS = ["npm", "PyPI", "Go", "Maven", "crates.io", "RubyGems", "Packagist", "NuGet"];
/** How much of each feed's head is read: a few days of changes in the busiest ecosystems. */
const FEED_HEAD_BYTES = 48 * 1024;
/** Changes older than this are not looked at. */
const CHANGED_WITHIN_MS = 3 * 86_400_000;
/** Records read per ecosystem, at most. Each is cached, so a refresh only fetches the ones that changed. */
const PER_ECOSYSTEM = 60;
const ADVISORIES = 24;
/** Advisories published longer ago than this were only edited recently: they only fill the list if there are too few new ones. */
const FRESH_MS = 7 * 86_400_000;
/** Findings read; after merging repeats, fewer are shown. */
const FINDINGS = 60;
const FINDINGS_SHOWN = 24;
/** Kinds whose dashboard name reads oddly on its own. */
const KIND: Record<string, string> = { business_logic: "Business logic flaw" };
/** Findings this new aren't shown yet, nor any older than FINDING_DAYS (see `recentFindingClasses`). */
const FINDING_DELAY_MS = 6 * 3_600_000;
const FINDING_DAYS = 30;
/** A day's findings are only shown once they came from at least this many orgs. */
const MIN_ORGS_PER_DAY = 3;
/** Text from OSV is cut to these lengths: it is someone else's data on our page. */
const MAX_SUMMARY = 160;
const MAX_PACKAGE = 100;
/** GitHub advisory IDs use a fixed alphabet; anything else in a feed is skipped. */
const GHSA_ID = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const CVE_ID = /^CVE-\d{4}-\d{4,8}$/;
const TIMEOUT_MS = 8_000;

const OSV_SEVERITY: Record<string, Severity> = { CRITICAL: "critical", HIGH: "high", MODERATE: "medium", LOW: "low" };

interface OsvRecord {
  id: string;
  aliases?: string[];
  summary?: string;
  published?: string;
  withdrawn?: string;
  affected?: Array<{ package?: { ecosystem?: string; name?: string } }>;
  database_specific?: { severity?: string };
}

async function osv(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${BUCKET}/${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok && response.status !== 206) throw new Error(`OSV returned ${response.status}`);
  return response;
}

/**
 * GitHub-reviewed advisories (they carry a summary and a severity) changed
 * in one ecosystem in the last few days, newest first, with when each changed.
 */
export function recentChanges(csv: string, now: number): Array<{ id: string; modified: string }> {
  const changes: Array<{ id: string; modified: string }> = [];
  const seen = new Set<string>();
  // The last line of a byte range may be cut short.
  for (const line of csv.split("\n").slice(0, -1)) {
    const comma = line.indexOf(",");
    const modified = line.slice(0, comma);
    // OSV writes up to nine fractional digits, more than `Date.parse` promises to read.
    const at = Date.parse(modified.replace(/(\.\d{3})\d+/, "$1"));
    if (comma < 0 || Number.isNaN(at)) continue;
    if (now - at > CHANGED_WITHIN_MS || changes.length === PER_ECOSYSTEM) break;
    const id = line.slice(comma + 1).trim();
    if (GHSA_ID.test(id) && !seen.has(id)) {
      seen.add(id);
      changes.push({ id, modified });
    }
  }
  return changes;
}

/** One record, cached by its ID and when it last changed: a record is only fetched again when OSV changes it. */
const record = unstable_cache(
  async (ecosystem: string, id: string, _modified: string): Promise<OsvRecord> => (await osv(`${encodeURIComponent(ecosystem)}/${encodeURIComponent(id)}.json`)).json() as Promise<OsvRecord>,
  ["osv-record-v1"],
  { revalidate: 7 * 86_400 },
);

/** Plain text on one line, no longer than `max`: control characters and runs of space collapse. */
function clean(text: string, max: number): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).replace(/\s+\S*$/, "")}…`;
}

/**
 * One advisory, in the words the crawl shows, from the record fetched for
 * `id` in `ecosystem`. Undefined for a record it can't show. Every field is
 * checked or rebuilt here, so nothing reaches the page in a shape we didn't
 * choose.
 */
export function toAdvisory(record: OsvRecord, ecosystem: string, id = record.id): FeedAdvisory | undefined {
  if (record.id !== id || !GHSA_ID.test(id) || !ECOSYSTEMS.includes(ecosystem)) return undefined;
  if (record.withdrawn || typeof record.summary !== "string" || typeof record.published !== "string") return undefined;
  const published = Date.parse(record.published);
  if (Number.isNaN(published)) return undefined;
  const name = record.affected?.find((a) => typeof a.package?.name === "string" && a.package.name.trim())?.package?.name;
  if (!name) return undefined;
  const pkg = clean(name, MAX_PACKAGE);
  const cve = (Array.isArray(record.aliases) ? record.aliases : []).filter((a) => typeof a === "string" && CVE_ID.test(a)).sort()[0];
  // Summaries often lead with the package name, which the crawl shows on its own.
  let summary = clean(record.summary, MAX_SUMMARY + name.length + 1);
  if (summary.startsWith(`${name}:`)) summary = summary.slice(name.length + 1).trim();
  summary = clean(summary, MAX_SUMMARY);
  if (!summary) return undefined;
  return {
    kind: "advisory",
    id: cve ?? id,
    summary: summary.charAt(0).toUpperCase() + summary.slice(1),
    severity: OSV_SEVERITY[record.database_specific?.severity ?? ""] ?? null,
    ecosystem,
    package: pkg,
    published: new Date(published).toISOString(),
    url: `https://osv.dev/vulnerability/${encodeURIComponent(id)}`,
  };
}

async function newestAdvisories(): Promise<FeedAdvisory[]> {
  const now = Date.now();
  const perEcosystem = await Promise.allSettled(
    ECOSYSTEMS.map(async (ecosystem) => {
      const head = await osv(`${encodeURIComponent(ecosystem)}/modified_id.csv`, { headers: { range: `bytes=0-${FEED_HEAD_BYTES - 1}` } });
      const changes = recentChanges(await head.text(), now);
      const records = await settleLimited(changes, (change) => record(ecosystem, change.id, change.modified));
      return records.flatMap((r, i) => (r.status === "fulfilled" ? [toAdvisory(r.value, ecosystem, changes[i]!.id)] : [])).filter((a) => a !== undefined);
    }),
  );
  const all = perEcosystem.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  if (all.length === 0 && perEcosystem.every((r) => r.status === "rejected")) throw new Error("OSV unreachable");
  return pickAdvisories(all, now);
}

/** Fetches in flight at once, across every ecosystem. */
let inFlight = 0;
const waiting: Array<() => void> = [];
const MAX_IN_FLIGHT = 24;

async function settleLimited<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  return Promise.allSettled(
    items.map(async (item) => {
      if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => waiting.push(resolve));
      inFlight++;
      try {
        return await run(item);
      } finally {
        inFlight--;
        waiting.shift()?.();
      }
    }),
  );
}

/** One per ID, newly published first, then recently edited older ones to fill the list. */
export function pickAdvisories(all: FeedAdvisory[], now: number): FeedAdvisory[] {
  const seen = new Set<string>();
  const unique = all
    .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
    .filter((a) => !seen.has(a.id) && seen.add(a.id));
  const fresh = unique.filter((a) => now - Date.parse(a.published) <= FRESH_MS);
  return (fresh.length >= 8 ? fresh : unique).slice(0, ADVISORIES);
}

/** "today", "yesterday" or "N days ago", by calendar day in UTC. */
export function foundDay(at: Date, now: Date): string {
  const day = (d: Date) => Math.floor(d.getTime() / 86_400_000);
  const days = day(now) - day(at);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

async function newestFindings(): Promise<FeedFinding[]> {
  const rows = await recentFindingClasses(db(), { limit: FINDINGS, minAgeMs: FINDING_DELAY_MS, maxAgeDays: FINDING_DAYS, minOrgs: MIN_ORGS_PER_DAY });
  return toFindings(rows, new Date());
}

const SEVERITY_SET = new Set<string>(SEVERITIES);
/** Only the engine's own kinds, so no free text can ever reach the page; and not the catch-all, which says nothing. */
const KIND_SET = new Set<string>(CATEGORIES.filter((c) => c !== "other"));

/**
 * Findings as the crawl shows them: severity, kind and day, one line for
 * each combination. Within a day they are ordered by severity and kind, not
 * by when they were found.
 */
export function toFindings(rows: Array<{ severity: string; category: string; firstSeenAt: Date }>, now: Date): FeedFinding[] {
  const days = (d: Date) => Math.floor(d.getTime() / 86_400_000);
  const kept = rows
    .filter((row) => SEVERITY_SET.has(row.severity) && KIND_SET.has(row.category) && !Number.isNaN(row.firstSeenAt.getTime()))
    .map((row) => ({ day: days(row.firstSeenAt), severity: row.severity as Severity, category: row.category, at: row.firstSeenAt }))
    .sort((a, b) => b.day - a.day || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || a.category.localeCompare(b.category));
  const seen = new Set<string>();
  const out: FeedFinding[] = [];
  for (const row of kept) {
    const finding: FeedFinding = { kind: "finding", severity: row.severity, title: KIND[row.category] ?? categoryLabel(row.category), found: foundDay(row.at, now) };
    const key = `${finding.severity}:${finding.title}:${finding.found}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
    if (out.length === FINDINGS_SHOWN) break;
  }
  return out;
}

async function readFeed(): Promise<Feed> {
  const [advisories, findings] = await Promise.allSettled([newestAdvisories(), newestFindings()]);
  // Either half alone still makes a feed; with neither, nothing is cached and the next request tries again.
  if (advisories.status === "rejected" && findings.status === "rejected") throw advisories.reason;
  return {
    advisories: advisories.status === "fulfilled" ? advisories.value : [],
    findings: findings.status === "fulfilled" ? findings.value : [],
  };
}

// Next's data cache, so every server instance (and every visitor) shares one copy.
export const liveFeed: () => Promise<Feed> = unstable_cache(readFeed, ["live-feed-v4"], { revalidate: FEED_TTL_S });
