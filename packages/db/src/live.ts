/**
 * What the hacker's page follows live: everything happening on an account
 * (scans starting and ending, their progress lines, findings, fixes, new
 * CVEs). Built to be read by one poller per server instance for every
 * account at once, not one per viewer: the tail reads walk primary keys
 * from a cursor, so each costs only what's new since the last read.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { advisories, findingEvents, findings, permissionCache, repoAdvisories, repos, scanEvents, scans } from "./schema";

/** A scan as the live feed knows it. */
export interface LiveScan {
  id: string;
  orgId: string;
  repoId: string;
  repo: string;
  kind: string;
  status: string;
  prNumber: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** How many findings it reported, once finished. */
  found: number | null;
}

export interface LiveLine {
  id: number;
  scanId: string;
  type: string;
  message: string;
  at: string;
}

export interface LiveFindingChange {
  id: number;
  orgId: string;
  repoId: string;
  repo: string;
  type: "fixed" | "dismissed" | "reopened";
  title: string;
  severity: string;
  findingId: string;
  at: string;
}

export interface LiveCve {
  repoId: string;
  repo: string;
  advisoryId: string;
  vuln: string;
  summary: string;
  severity: string;
  name: string;
  version: string;
  at: string;
}

/** Where a tail read starts: the newest progress line and finding change already seen, and scans created since when. */
export interface LiveCursor {
  line: number;
  change: number;
  createdSince: string;
}

export interface LiveTail {
  lines: LiveLine[];
  /** Every scan the new lines belong to, those created since the cursor, and those asked after (`watch`). */
  scans: LiveScan[];
  changes: LiveFindingChange[];
  cursor: LiveCursor;
}

/** A list of ids as one parameter (an empty list is an empty array). */
const uuids = (ids: string[]) => sql`string_to_array(${ids.join(",")}, ',')::uuid[]`;

const SCAN_FIELDS = sql`s.id, s.org_id as "orgId", s.repo_id as "repoId", r.full_name as repo, s.kind, s.status, s.pr_number as "prNumber",
  s.created_at as "createdAt", s.started_at as "startedAt", s.finished_at as "finishedAt",
  case when s.status = 'completed' then jsonb_array_length(coalesce(s.stats -> 'findingIds', '[]'::jsonb)) end as found`;

/** Where to start following from now: the newest of each, so a new poller sends nothing old. */
export async function liveCursorNow(database: Db): Promise<LiveCursor> {
  const [row] = await database.execute<{ line: string | null; change: string | null; now: string }>(sql`
    select (select max(id) from ${scanEvents}) as line, (select max(id) from ${findingEvents}) as change, now() as now
  `);
  return { line: Number(row?.line ?? 0), change: Number(row?.change ?? 0), createdSince: new Date(row?.now ?? Date.now()).toISOString() };
}

/**
 * Everything new across every account since `cursor`, in one round trip:
 * progress lines (by primary key, at most `limit`), the scans they belong to
 * plus scans created since and the scans in `watch` (to see them end),
 * and fixes, dismissals and reopenings of findings. The cursor it returns
 * picks up exactly where this read stopped.
 */
export async function liveTail(database: Db, cursor: LiveCursor, watch: string[], limit = 400): Promise<LiveTail> {
  const [row] = await database.execute<{ lines: LiveLine[]; scans: LiveScan[]; changes: LiveFindingChange[]; lastChange: string | null; newest: string | null }>(sql`
    with l as (
      select id, scan_id as "scanId", type, message, created_at as at from ${scanEvents}
      where id > ${cursor.line} order by id limit ${limit}
    ),
    c as (
      select fe.id, r.org_id as "orgId", f.repo_id as "repoId", r.full_name as repo, fe.type, f.title, f.severity, f.id as "findingId", fe.created_at as at
      from ${findingEvents} fe join ${findings} f on f.id = fe.finding_id join ${repos} r on r.id = f.repo_id
      where fe.id > ${cursor.change} and fe.type in ('fixed', 'dismissed', 'reopened')
      order by fe.id limit ${limit}
    )
    select
      coalesce((select json_agg(l order by l.id) from l), '[]'::json) as lines,
      -- The scans wanted, each found by its own index (an "or" of the three would read the whole table).
      coalesce((select json_agg(x) from (
        select ${SCAN_FIELDS} from ${scans} s join ${repos} r on r.id = s.repo_id
        where s.id in (
          select "scanId" from l
          union select unnest(${uuids(watch)})
          union select id from ${scans} where created_at > ${cursor.createdSince}::timestamptz
        )
      ) x), '[]'::json) as scans,
      coalesce((select json_agg(c order by c.id) from c), '[]'::json) as changes,
      -- Past the changes not shown (seen, copied prompts), so they're never read again; never past what this read covered.
      (select max(id) from (select id from ${findingEvents} where id > ${cursor.change} order by id limit ${limit}) seen) as "lastChange",
      (select max(created_at) from ${scans} where created_at > ${cursor.createdSince}::timestamptz) as newest
  `);
  const lines = row?.lines ?? [];
  return {
    lines,
    scans: row?.scans ?? [],
    changes: row?.changes ?? [],
    cursor: {
      line: lines.at(-1)?.id ?? cursor.line,
      change: Number(row?.lastChange ?? cursor.change),
      createdSince: row?.newest ? new Date(row.newest).toISOString() : cursor.createdSince,
    },
  };
}

/** Advisories newly affecting any of `repoIds` since `since`: the open matches, newest last. */
export async function liveCves(database: Db, repoIds: string[], since: string, limit = 50): Promise<LiveCve[]> {
  if (repoIds.length === 0) return [];
  return database.execute<LiveCve & Record<string, unknown>>(sql`
    select ra.repo_id as "repoId", r.full_name as repo, ra.advisory_id as "advisoryId", a.vuln_key as vuln, a.summary, a.severity, ra.name, ra.version, ra.first_seen_at as at
    from ${repoAdvisories} ra join ${advisories} a on a.id = ra.advisory_id join ${repos} r on r.id = ra.repo_id
    where ra.repo_id = any(${uuids(repoIds)}) and ra.resolved_at is null and ra.first_seen_at > ${since}::timestamptz
    order by ra.first_seen_at limit ${limit}
  `) as unknown as Promise<LiveCve[]>;
}

/** The repositories of `orgId` this person can see (enabled ones), by id. */
export async function liveRepos(database: Db, userId: string, orgId: string): Promise<string[]> {
  const rows = await database.execute<{ id: string }>(sql`
    select r.id from ${repos} r join ${permissionCache} pc on pc.repo_id = r.id and pc.user_id = ${userId}
    where r.org_id = ${orgId} and r.enabled
  `);
  return rows.map((row) => row.id);
}

/** All of an account's enabled repositories, for its CVE reads. */
export async function liveOrgRepos(database: Db, orgId: string): Promise<string[]> {
  const rows = await database.execute<{ id: string }>(sql`select id from ${repos} where org_id = ${orgId} and enabled`);
  return rows.map((row) => row.id);
}

export interface LiveHistory {
  /** The latest scans, newest first, and every one still going. */
  scans: LiveScan[];
  /** Their findings and stage lines, and each running scan's latest line. */
  lines: LiveLine[];
  changes: LiveFindingChange[];
  cves: LiveCve[];
}

/**
 * What the feed shows the moment the page opens, for one person on one
 * account (or for everyone on it, with no person: the live feed keeps that
 * and gives each viewer their share), in one round trip: the latest scans with their findings and
 * stages, recent fixes and dismissals, and recent CVE matches, over the
 * last `days`.
 */
export async function liveHistory(database: Db, userId: string | null, orgId: string, options: { scans?: number; days?: number } = {}): Promise<LiveHistory> {
  const count = options.scans ?? 12;
  const days = options.days ?? 14;
  const [row] = await database.execute<LiveHistory & Record<string, unknown>>(sql`
    with vis as (
      select r.id, r.full_name from ${repos} r
      where r.org_id = ${orgId} and r.enabled
        and (${userId}::uuid is null or exists (select 1 from ${permissionCache} pc where pc.repo_id = r.id and pc.user_id = ${userId}::uuid))
    ),
    recent as (
      (select s.id from ${scans} s where s.org_id = ${orgId} and s.repo_id in (select id from vis) order by s.created_at desc limit ${count})
      union
      (select s.id from ${scans} s where s.org_id = ${orgId} and s.repo_id in (select id from vis) and s.status in ('queued', 'running', 'publishing'))
    )
    select
      coalesce((select json_agg(x order by x."createdAt" desc) from (
        select ${SCAN_FIELDS} from ${scans} s join ${repos} r on r.id = s.repo_id where s.id in (select id from recent)
      ) x), '[]'::json) as scans,
      coalesce((select json_agg(x order by x.id) from (
        select e.id, e.scan_id as "scanId", e.type, e.message, e.created_at as at from ${scanEvents} e
        where e.scan_id in (select id from recent) and (e.type = 'finding' or e.type like 'stage:%')
        union all
        select * from (
          select distinct on (e.scan_id) e.id, e.scan_id, e.type, e.message, e.created_at from ${scanEvents} e
          join ${scans} s on s.id = e.scan_id
          where e.scan_id in (select id from recent) and s.status in ('queued', 'running', 'publishing')
          order by e.scan_id, e.seq desc
        ) last
      ) x), '[]'::json) as lines,
      coalesce((select json_agg(x order by x.id) from (
        select fe.id, r.org_id as "orgId", f.repo_id as "repoId", r.full_name as repo, fe.type, f.title, f.severity, f.id as "findingId", fe.created_at as at
        from ${findingEvents} fe join ${findings} f on f.id = fe.finding_id join ${repos} r on r.id = f.repo_id
        where fe.type in ('fixed', 'dismissed', 'reopened') and fe.created_at > now() - make_interval(days => ${days})
          and f.repo_id in (select id from vis)
        order by fe.id desc limit 20
      ) x), '[]'::json) as changes,
      coalesce((select json_agg(x order by x.at) from (
        select ra.repo_id as "repoId", r.full_name as repo, ra.advisory_id as "advisoryId", a.vuln_key as vuln, a.summary, a.severity, ra.name, ra.version, ra.first_seen_at as at
        from ${repoAdvisories} ra join ${advisories} a on a.id = ra.advisory_id join ${repos} r on r.id = ra.repo_id
        where ra.repo_id in (select id from vis) and ra.resolved_at is null and ra.first_seen_at > now() - make_interval(days => ${days})
        order by ra.first_seen_at desc limit 20
      ) x), '[]'::json) as cves
  `);
  return { scans: row?.scans ?? [], lines: (row?.lines ?? []).map((l) => ({ ...l, id: Number(l.id) })), changes: (row?.changes ?? []).map((c) => ({ ...c, id: Number(c.id) })), cves: row?.cves ?? [] };
}
