/**
 * What the landing page's crawl shows: the newest security advisories
 * published to OSV, and the newest findings Sandchest has made. Advisories
 * are public records. Findings are reduced to their severity, their kind and
 * the day they were found, never anything that says whose code they are in.
 * One copy for everyone, rebuilt at most every ten minutes.
 */
import { recentFindingClasses } from "@sandchest/db";
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
/** Findings this new aren't shown yet (see `recentFindingClasses`). */
const FINDING_DELAY_MS = 6 * 3_600_000;
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
    if (id.startsWith("GHSA-") && !seen.has(id)) {
      seen.add(id);
      changes.push({ id, modified });
    }
  }
  return changes;
}

/** One record, cached by its ID and when it last changed: a record is only fetched again when OSV changes it. */
const record = unstable_cache(
  async (ecosystem: string, id: string, _modified: string): Promise<OsvRecord> => (await osv(`${encodeURIComponent(ecosystem)}/${id}.json`)).json() as Promise<OsvRecord>,
  ["osv-record-v1"],
  { revalidate: 7 * 86_400 },
);

/** One advisory, in the words the crawl shows. Undefined for a record it can't show. */
export function toAdvisory(record: OsvRecord, ecosystem: string): FeedAdvisory | undefined {
  if (record.withdrawn || !record.summary || !record.published) return undefined;
  const pkg = record.affected?.find((a) => a.package?.name)?.package;
  if (!pkg?.name) return undefined;
  const cve = record.aliases?.filter((a) => a.startsWith("CVE-")).sort()[0];
  // Summaries often lead with the package name, which the crawl shows on its own.
  const lead = `${pkg.name}:`;
  const summary = (record.summary.startsWith(lead) ? record.summary.slice(lead.length) : record.summary).trim();
  return {
    kind: "advisory",
    id: cve ?? record.id,
    summary: summary.charAt(0).toUpperCase() + summary.slice(1),
    severity: OSV_SEVERITY[record.database_specific?.severity ?? ""] ?? null,
    ecosystem: pkg.ecosystem ?? ecosystem,
    package: pkg.name,
    published: record.published,
    url: `https://osv.dev/vulnerability/${record.id}`,
  };
}

async function newestAdvisories(): Promise<FeedAdvisory[]> {
  const now = Date.now();
  const perEcosystem = await Promise.allSettled(
    ECOSYSTEMS.map(async (ecosystem) => {
      const head = await osv(`${encodeURIComponent(ecosystem)}/modified_id.csv`, { headers: { range: `bytes=0-${FEED_HEAD_BYTES - 1}` } });
      const changes = recentChanges(await head.text(), now);
      const records = await settleLimited(changes, (change) => record(ecosystem, change.id, change.modified));
      return records.flatMap((r) => (r.status === "fulfilled" ? [toAdvisory(r.value, ecosystem)] : [])).filter((a) => a !== undefined);
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
  const rows = await recentFindingClasses(db(), { limit: FINDINGS, minAgeMs: FINDING_DELAY_MS });
  return toFindings(rows, new Date());
}

/** Findings as the crawl shows them: one line per kind, severity and day, and none of the catch-all kind, which says nothing. */
export function toFindings(rows: Array<{ severity: Severity; category: string; firstSeenAt: Date }>, now: Date): FeedFinding[] {
  const seen = new Set<string>();
  const out: FeedFinding[] = [];
  for (const row of rows) {
    if (row.category === "other") continue;
    const finding: FeedFinding = { kind: "finding", severity: row.severity, title: KIND[row.category] ?? categoryLabel(row.category), found: foundDay(row.firstSeenAt, now) };
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
export const liveFeed: () => Promise<Feed> = unstable_cache(readFeed, ["live-feed-v3"], { revalidate: FEED_TTL_S });
