/**
 * The CVE directory's storage: each repository's dependency inventory, the
 * OSV advisories that matched one, and which repositories each affects.
 * Reads for people are scoped through `permission_cache`, as every dashboard
 * read is (see dashboard.ts).
 */
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import { advisories, advisoryFeeds, permissionCache, repoAdvisories, repoDependencies, repoInventories, repoMemory, repos, orgs, type AdvisorySeverity, type DependencyUsage } from "./schema";

export interface InventoryRow {
  ecosystem: string;
  name: string;
  key: string;
  version: string;
  manifest: string;
  direct: boolean;
  dev: boolean;
  usage: DependencyUsage;
  approximate: boolean;
  importedAt: string[];
}

export type PackageVersion = {
  ecosystem: string;
  name: string;
  version: string;
};

export type AdvisoryRow = typeof advisories.$inferInsert;

const INSERT_CHUNK = 2_000;

// ---- Inventories ------------------------------------------------------------

/**
 * Replaces a repository's inventory with one read at `startedAt` from
 * `commitSha`, unless an inventory read later has already been saved. Matches
 * for versions no longer installed are resolved. Returns whether it was saved.
 */
export async function saveInventory(database: Db, repoId: string, commitSha: string, startedAt: Date, entries: InventoryRow[]): Promise<boolean> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${repoId}, 4))`);
    const [current] = await tx.select({ capturedAt: repoInventories.capturedAt }).from(repoInventories).where(eq(repoInventories.repoId, repoId));
    if (current?.capturedAt && current.capturedAt > startedAt) return false;

    await tx.delete(repoDependencies).where(eq(repoDependencies.repoId, repoId));
    for (let start = 0; start < entries.length; start += INSERT_CHUNK) {
      await tx.insert(repoDependencies).values(
        entries.slice(start, start + INSERT_CHUNK).map((entry) => ({
          repoId,
          ecosystem: entry.ecosystem,
          name: entry.name,
          packageKey: entry.key,
          version: entry.version,
          manifest: entry.manifest,
          direct: entry.direct,
          dev: entry.dev,
          usage: entry.usage,
          approximate: entry.approximate,
          importedAt: entry.importedAt,
        })),
      );
    }
    // A request that arrived after this read began still wants a newer one.
    const requested = sql`case when ${repoInventories.requestedAt} > ${startedAt.toISOString()}::timestamptz then ${repoInventories.requestedAt} else null end`;
    await tx
      .insert(repoInventories)
      .values({ repoId, commitSha, capturedAt: startedAt, dependencies: entries.length, error: null })
      .onConflictDoUpdate({ target: repoInventories.repoId, set: { commitSha, capturedAt: startedAt, dependencies: entries.length, requestedAt: requested, error: null } });
    // An ecosystem's change feed is followed from the first inventory that installs from it; until then the
    // inventory's own full check covers it.
    const ecosystems = [...new Set(entries.map((entry) => entry.ecosystem))];
    if (ecosystems.length > 0) {
      await tx
        .insert(advisoryFeeds)
        .values(ecosystems.map((ecosystem) => ({ ecosystem, cursor: String(startedAt.getTime()) })))
        .onConflictDoNothing();
    }
    // Upgraded or removed: the version is gone, so are its advisories.
    await tx.execute(sql`
      update ${repoAdvisories} ra set resolved_at = now()
      where ra.repo_id = ${repoId} and ra.resolved_at is null
        and not exists (
          select 1 from ${repoDependencies} d
          where d.repo_id = ra.repo_id and d.ecosystem = ra.ecosystem and d.name = ra.name and d.version = ra.version
        )`);
    return true;
  });
}

/** A repository and its org, for reading its inventory. */
export async function inventoryRepo(database: Db, repoId: string) {
  return database.query.repos.findFirst({ where: eq(repos.id, repoId), with: { org: true } });
}

/** Every package version a repository installs, once each. */
export async function inventoryPackages(database: Db, repoId: string): Promise<PackageVersion[]> {
  return database
    .selectDistinct({ ecosystem: repoDependencies.ecosystem, name: repoDependencies.name, version: repoDependencies.version })
    .from(repoDependencies)
    .where(eq(repoDependencies.repoId, repoId));
}

/** The versions of these packages any repository installs: what a changed advisory must be checked against. */
export async function installedVersions(database: Db, packages: Array<{ ecosystem: string; key: string }>): Promise<PackageVersion[]> {
  if (packages.length === 0) return [];
  const wanted = JSON.stringify(packages.map((p) => ({ ecosystem: p.ecosystem, key: p.key })));
  const rows = await database.execute<PackageVersion>(sql`
    select distinct d.ecosystem, d.name, d.version
    from ${repoDependencies} d
    join jsonb_to_recordset(${wanted}::jsonb) as w(ecosystem text, key text) on w.ecosystem = d.ecosystem and w.key = d.package_key`);
  return [...rows];
}

/** Marks repositories' inventories as checked against OSV at `at`. */
export async function markInventoriesChecked(database: Db, repoIds: string[], at: Date): Promise<void> {
  if (repoIds.length === 0) return;
  await database.update(repoInventories).set({ checkedAt: at }).where(inArray(repoInventories.repoId, repoIds));
}

/** A push changed a manifest or lockfile: the inventory should be read again. */
export async function requestInventory(database: Db, repoId: string, at = new Date()): Promise<void> {
  // A new push is a new chance: whatever failed before may be fixed by it.
  await database.insert(repoInventories).values({ repoId, requestedAt: at }).onConflictDoUpdate({ target: repoInventories.repoId, set: { requestedAt: at, failures: 0, failedAt: null } });
}

/** How long a refresh may hold a repository before another may take over. */
const REFRESH_LEASE = sql`interval '20 minutes'`;

/** Takes a repository for an inventory refresh; false if another refresh holds it. */
export async function claimInventoryRefresh(database: Db, repoId: string): Promise<boolean> {
  await database.insert(repoInventories).values({ repoId }).onConflictDoNothing();
  const claimed = await database
    .update(repoInventories)
    .set({ runningSince: new Date() })
    .where(and(eq(repoInventories.repoId, repoId), or(isNull(repoInventories.runningSince), sql`${repoInventories.runningSince} < now() - ${REFRESH_LEASE}`)))
    .returning({ repoId: repoInventories.repoId });
  return claimed.length > 0;
}

/** Ends a refresh. With `error`, it failed: the repository backs off before the next try. */
export async function releaseInventoryRefresh(database: Db, repoId: string, error?: string): Promise<void> {
  await database
    .update(repoInventories)
    .set(
      error === undefined
        ? { runningSince: null, error: null, failures: 0, failedAt: null }
        : { runningSince: null, error: error.slice(0, 500), failures: sql`${repoInventories.failures} + 1`, failedAt: new Date() },
    )
    .where(eq(repoInventories.repoId, repoId));
}

/** After this many failed refreshes in a row a repository waits for its next lockfile push. */
export const MAX_REFRESH_FAILURES = 6;

/**
 * Repositories whose inventory should be read now: asked for by a push, or
 * never read. Only repositories that are installed, enabled and already
 * mapped (recon ran, so the account has a plan), and not being read already.
 */
export async function inventoriesDue(database: Db, limit: number): Promise<string[]> {
  const rows = await database
    .select({ id: repos.id })
    .from(repos)
    .innerJoin(orgs, eq(orgs.id, repos.orgId))
    .innerJoin(repoMemory, eq(repoMemory.repoId, repos.id))
    .leftJoin(repoInventories, eq(repoInventories.repoId, repos.id))
    .where(
      and(
        eq(repos.enabled, true),
        isNotNull(orgs.installationId),
        or(isNull(repoInventories.repoId), isNull(repoInventories.capturedAt), isNotNull(repoInventories.requestedAt)),
        or(isNull(repoInventories.runningSince), sql`${repoInventories.runningSince} < now() - ${REFRESH_LEASE}`),
        // Failing repositories back off: 20 minutes, then 40, 80… and stop until the next push.
        or(isNull(repoInventories.failedAt), sql`${repoInventories.failedAt} < now() - interval '20 minutes' * power(2, ${repoInventories.failures} - 1)`),
        or(isNull(repoInventories.failures), lt(repoInventories.failures, MAX_REFRESH_FAILURES)),
      ),
    )
    .orderBy(sql`${repoInventories.requestedAt} desc nulls last`)
    .limit(limit);
  return rows.map((row) => row.id);
}

/** Inventories not checked against OSV since `before`: the safety net behind the change feed. */
export async function inventoriesUnchecked(database: Db, before: Date, limit: number): Promise<Array<{ repoId: string; checkedAt: Date | null }>> {
  return database
    .select({ repoId: repoInventories.repoId, checkedAt: repoInventories.checkedAt })
    .from(repoInventories)
    .innerJoin(repos, eq(repos.id, repoInventories.repoId))
    .where(and(eq(repos.enabled, true), isNotNull(repoInventories.capturedAt), or(isNull(repoInventories.checkedAt), lt(repoInventories.checkedAt, before))))
    .orderBy(sql`${repoInventories.checkedAt} asc nulls first`)
    .limit(limit);
}

// ---- Advisories -------------------------------------------------------------

/** When each stored advisory last changed, so unchanged ones aren't fetched again. */
export async function storedAdvisories(database: Db, ids: string[]): Promise<Map<string, Date>> {
  if (ids.length === 0) return new Map();
  const rows = await database.select({ id: advisories.id, modifiedAt: advisories.modifiedAt }).from(advisories).where(inArray(advisories.id, ids));
  return new Map(rows.map((row) => [row.id, row.modifiedAt]));
}

export async function upsertAdvisories(database: Db, rows: AdvisoryRow[]): Promise<void> {
  for (let start = 0; start < rows.length; start += 500) {
    const chunk = rows.slice(start, start + 500);
    await database
      .insert(advisories)
      .values(chunk)
      .onConflictDoUpdate({
        target: advisories.id,
        set: {
          vulnKey: sql`excluded.vuln_key`,
          aliases: sql`excluded.aliases`,
          summary: sql`excluded.summary`,
          details: sql`excluded.details`,
          severity: sql`excluded.severity`,
          score: sql`excluded.score`,
          vector: sql`excluded.vector`,
          malicious: sql`excluded.malicious`,
          affected: sql`excluded.affected`,
          references: sql`excluded.references`,
          publishedAt: sql`excluded.published_at`,
          modifiedAt: sql`excluded.modified_at`,
          withdrawnAt: sql`excluded.withdrawn_at`,
          fetchedAt: sql`now()`,
        },
      });
  }
}

export type NewMatch = {
  repoId: string;
  advisoryId: string;
  ecosystem: string;
  name: string;
  version: string;
};

/**
 * Records what OSV said about `checked` package versions: each repository
 * installing one is affected by exactly the advisories in `matches` for it
 * (keyed `ecosystem\0name\0version`). New matches are added, ones OSV no
 * longer reports for that version are resolved, and ones it reports again
 * are reopened. Only advisories already stored are applied. `repoId` limits
 * it to one repository. Returns the matches added.
 */
export async function applyMatches(
  database: Db,
  input: { checked: PackageVersion[]; matches: Map<string, string[]>; origin: "feed" | "inventory"; repoId?: string },
): Promise<NewMatch[]> {
  if (input.checked.length === 0) return [];
  const checked = JSON.stringify(input.checked.map(({ ecosystem, name, version }) => ({ ecosystem, name, version })));
  const wanted = JSON.stringify(
    input.checked.flatMap(({ ecosystem, name, version }) => (input.matches.get(matchKey({ ecosystem, name, version })) ?? []).map((advisory) => ({ ecosystem, name, version, advisory }))),
  );
  const repoFilter = input.repoId ? sql`and d.repo_id = ${input.repoId}` : sql``;
  const raRepoFilter = input.repoId ? sql`and ra.repo_id = ${input.repoId}` : sql``;
  return database.transaction(async (tx) => {
    const added = await tx.execute<NewMatch & { inserted: boolean }>(sql`
      insert into ${repoAdvisories} (repo_id, advisory_id, ecosystem, name, version, origin)
      select d.repo_id, w.advisory, d.ecosystem, d.name, d.version, ${input.origin}
      from jsonb_to_recordset(${wanted}::jsonb) as w(ecosystem text, name text, version text, advisory text)
      join ${repoDependencies} d on d.ecosystem = w.ecosystem and d.name = w.name and d.version = w.version ${repoFilter}
      join ${advisories} a on a.id = w.advisory
      on conflict (repo_id, advisory_id, ecosystem, name, version) do update set last_seen_at = now(), resolved_at = null
      returning repo_id as "repoId", advisory_id as "advisoryId", ecosystem, name, version, (xmax = 0) as inserted`);
    await tx.execute(sql`
      update ${repoAdvisories} ra set resolved_at = now()
      from jsonb_to_recordset(${checked}::jsonb) as c(ecosystem text, name text, version text)
      where ra.ecosystem = c.ecosystem and ra.name = c.name and ra.version = c.version and ra.resolved_at is null ${raRepoFilter}
        and not exists (
          select 1 from jsonb_to_recordset(${wanted}::jsonb) as w(ecosystem text, name text, version text, advisory text)
          where w.ecosystem = ra.ecosystem and w.name = ra.name and w.version = ra.version and w.advisory = ra.advisory_id
        )`);
    // A whole-repository check also settles matches whose version a concurrent inventory read removed
    // after the insert above saw it (the reopen would otherwise outlive the version).
    if (input.repoId) {
      await tx.execute(sql`
        update ${repoAdvisories} ra set resolved_at = now()
        where ra.repo_id = ${input.repoId} and ra.resolved_at is null
          and not exists (
            select 1 from ${repoDependencies} d
            where d.repo_id = ra.repo_id and d.ecosystem = ra.ecosystem and d.name = ra.name and d.version = ra.version
          )`);
    }
    return [...added].filter((row) => row.inserted).map(({ repoId, advisoryId, ecosystem, name, version }) => ({ repoId, advisoryId, ecosystem, name, version }));
  });
}

export function matchKey(pkg: PackageVersion): string {
  return `${pkg.ecosystem}\0${pkg.name}\0${pkg.version}`;
}

/** Every followed change feed and how far it has been read (ms since the epoch). */
export async function feedCursors(database: Db): Promise<Array<{ ecosystem: string; cursor: number }>> {
  const rows = await database.select({ ecosystem: advisoryFeeds.ecosystem, cursor: advisoryFeeds.cursor }).from(advisoryFeeds);
  return rows.map((row) => ({ ecosystem: row.ecosystem, cursor: Number(row.cursor) }));
}

/** Runs `fn` unless another feed sync is running, so syncs started a minute apart never overlap. */
export async function exclusiveFeedSync<T>(database: Db, fn: () => Promise<T>): Promise<T | undefined> {
  return database.transaction(async (tx) => {
    const [row] = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended('advisory_feeds', 5)) as locked`);
    return row?.locked ? fn() : undefined;
  });
}

export async function setFeedCursor(database: Db, ecosystem: string, cursor: number): Promise<void> {
  await database
    .insert(advisoryFeeds)
    .values({ ecosystem, cursor: String(cursor) })
    .onConflictDoUpdate({ target: advisoryFeeds.ecosystem, set: { cursor: String(cursor), syncedAt: sql`now()` } });
}

// ---- What people see ----------------------------------------------------------

export type CveState = "in_code" | "installed" | "resolved";

export interface CveMatch {
  repoId: string;
  repoFullName: string;
  /** The commit the repository's inventory was read from, for links to the import sites. */
  commitSha: string | null;
  advisoryId: string;
  ecosystem: string;
  name: string;
  version: string;
  manifest: string | null;
  direct: boolean;
  dev: boolean;
  usage: DependencyUsage | null;
  approximate: boolean;
  importedAt: string[];
  firstSeenAt: Date;
  resolvedAt: Date | null;
  origin: "feed" | "inventory";
}

export interface CveRecord {
  id: string;
  aliases: string[];
  summary: string;
  severity: AdvisorySeverity;
  score: number | null;
  malicious: boolean;
  publishedAt: Date | null;
}

/** One vulnerability (every OSV record of it) and where it affects the person's repositories. */
export interface CveListItem {
  /** Its CVE id when it has one, else the advisory id. */
  key: string;
  /** The record shown: GitHub's when there is one, as it carries the rating. */
  primary: CveRecord;
  ids: string[];
  severity: AdvisorySeverity;
  state: CveState;
  matches: CveMatch[];
  firstSeenAt: Date;
  /** Published or first matched in the last week, through a new advisory rather than a push. */
  fresh: boolean;
}

export interface CveFilters {
  state?: CveState;
  severities?: AdvisorySeverity[];
  repoId?: string;
  /** A CVE or advisory id, or part of a package name or summary. */
  query?: string;
}

const MAX_ROWS = 10_000;
const FRESH_MS = 7 * 86_400_000;

/**
 * Whether a match is inside the product: an affected version that shipped code
 * imports (not a dev dependency, and not a range's guess).
 */
export function inCode(match: Pick<CveMatch, "usage" | "dev" | "approximate" | "resolvedAt">): boolean {
  return match.resolvedAt === null && match.usage === "product" && !match.dev && !match.approximate;
}

/**
 * Every vulnerability matched in the repositories the user can see, one item
 * each however many OSV records describe it, most exposed and severe first.
 * `counts` is per state, before the state filter.
 */
export async function dashboardCves(database: Db, userId: string, filters: CveFilters = {}, now = new Date()): Promise<{ list: CveListItem[]; counts: Record<CveState, number> }> {
  return filterCves(groupCves(await matchRows(database, userId, { repoId: filters.repoId }), now), filters);
}

/** Items matching the filters, in the chosen state, with counts per state across the other filters. */
export function filterCves(all: CveListItem[], filters: CveFilters): { list: CveListItem[]; counts: Record<CveState, number> } {
  const query = filters.query?.trim().toLowerCase();
  const matching = all.filter(
    (item) =>
      (!filters.repoId || item.matches.some((m) => m.repoId === filters.repoId)) &&
      (!filters.severities?.length || filters.severities.includes(item.severity)) &&
      (!query ||
        item.key.toLowerCase().includes(query) ||
        item.ids.some((id) => id.toLowerCase() === query) ||
        item.primary.aliases.some((a) => a.toLowerCase() === query) ||
        item.matches.some((m) => m.name.toLowerCase().includes(query)) ||
        item.primary.summary.toLowerCase().includes(query)),
  );
  const counts: Record<CveState, number> = { in_code: 0, installed: 0, resolved: 0 };
  for (const item of matching) counts[item.state]++;
  return { list: matching.filter((item) => item.state === (filters.state ?? "in_code")), counts };
}

/** One vulnerability by its CVE id, advisory id or alias, with every match in the user's repositories; undefined if none. */
export async function cveForUser(database: Db, userId: string, key: string, now = new Date()) {
  const ids = await database
    .select({ id: advisories.id, vulnKey: advisories.vulnKey })
    .from(advisories)
    .where(or(eq(advisories.vulnKey, key), eq(advisories.id, key), sql`${key} = any(${advisories.aliases})`));
  if (ids.length === 0) return undefined;
  const keys = [...new Set(ids.map((row) => row.vulnKey))];
  const records = await database.select().from(advisories).where(inArray(advisories.vulnKey, keys));
  const rows = await matchRows(database, userId, { advisoryIds: records.map((r) => r.id) });
  if (rows.length === 0) return undefined;
  const [item] = groupCves(rows, now);
  if (!item) return undefined;
  const primary = records.find((r) => r.id === item.primary.id)!;
  return { item, records, advisory: primary };
}

/** How current the directory is for the user: repositories with an inventory, of those they can see, and the oldest check. */
export async function cveCoverage(database: Db, userId: string): Promise<{ repos: number; inventoried: number; checkedAt: Date | null }> {
  const [row] = await database.execute<{ repos: number; inventoried: number; checked_at: Date | null }>(sql`
    select count(*)::int as repos, count(i.captured_at)::int as inventoried, min(i.checked_at) as checked_at
    from ${repos} r
    join ${permissionCache} pc on pc.repo_id = r.id and pc.user_id = ${userId}
    left join ${repoInventories} i on i.repo_id = r.id
    where r.enabled`);
  return { repos: row?.repos ?? 0, inventoried: row?.inventoried ?? 0, checkedAt: row?.checked_at ? new Date(row.checked_at) : null };
}

export type CveMatchRow = MatchRow;

type MatchRow = {
  repo_id: string;
  repo_full_name: string;
  commit_sha: string | null;
  advisory_id: string;
  vuln_key: string;
  aliases: string[];
  summary: string;
  severity: AdvisorySeverity;
  score: number | null;
  malicious: boolean;
  published_at: Date | null;
  ecosystem: string;
  name: string;
  version: string;
  manifest: string | null;
  direct: boolean | null;
  dev: boolean | null;
  usage: DependencyUsage | null;
  approximate: boolean | null;
  imported_at: string[] | null;
  first_seen_at: Date;
  resolved_at: Date | null;
  origin: "feed" | "inventory";
};

async function matchRows(database: Db, userId: string, scope: { repoId?: string; advisoryIds?: string[] }): Promise<MatchRow[]> {
  const repoFilter = scope.repoId ? sql`and ra.repo_id = ${scope.repoId}` : sql``;
  const advisoryFilter = scope.advisoryIds ? sql`and ra.advisory_id in (select jsonb_array_elements_text(${JSON.stringify(scope.advisoryIds)}::jsonb))` : sql``;
  const rows = await database.execute<MatchRow>(sql`
    select ra.repo_id, r.full_name as repo_full_name, i.commit_sha, ra.advisory_id, a.vuln_key, a.aliases, a.summary, a.severity, a.score, a.malicious, a.published_at,
      ra.ecosystem, ra.name, ra.version, d.manifest, d.direct, d.dev, d.usage, d.approximate, d.imported_at, ra.first_seen_at, ra.resolved_at, ra.origin
    from ${repoAdvisories} ra
    join ${repos} r on r.id = ra.repo_id and r.enabled
    join ${permissionCache} pc on pc.repo_id = ra.repo_id and pc.user_id = ${userId}
    join ${advisories} a on a.id = ra.advisory_id and a.withdrawn_at is null
    left join ${repoInventories} i on i.repo_id = ra.repo_id
    left join ${repoDependencies} d on d.repo_id = ra.repo_id and d.ecosystem = ra.ecosystem and d.name = ra.name and d.version = ra.version
    where (ra.resolved_at is null or ra.resolved_at > now() - interval '90 days') ${repoFilter} ${advisoryFilter}
    order by (ra.resolved_at is null) desc, ra.first_seen_at desc
    limit ${MAX_ROWS}`);
  return [...rows];
}

const SEVERITY_RANK: Record<AdvisorySeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
const STATE_RANK: Record<CveState, number> = { in_code: 0, installed: 1, resolved: 2 };

/** Groups match rows into one item per vulnerability. Exported for tests. */
export function groupCves(rows: CveMatchRow[], now = new Date()): CveListItem[] {
  const groups = new Map<string, MatchRow[]>();
  for (const row of rows) {
    const list = groups.get(row.vuln_key);
    if (list) list.push(row);
    else groups.set(row.vuln_key, [row]);
  }
  const items: CveListItem[] = [];
  for (const [key, group] of groups) {
    const records = new Map<string, CveRecord>();
    for (const row of group) {
      records.set(row.advisory_id, { id: row.advisory_id, aliases: row.aliases, summary: row.summary, severity: row.severity, score: row.score === null ? null : Number(row.score), malicious: row.malicious, publishedAt: row.published_at ? new Date(row.published_at) : null });
    }
    const ranked = [...records.values()].sort((a, b) => Number(!a.id.startsWith("GHSA-")) - Number(!b.id.startsWith("GHSA-")) || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.score ?? 0) - (a.score ?? 0));
    const primary = ranked[0]!;
    // The primary's own rating, or the best any record of it gives when the primary has none.
    const severity = primary.severity !== "unknown" ? primary.severity : (ranked.map((r) => r.severity).sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0] ?? "unknown");
    // One match per repository and installed version, however many records name it.
    const matches: CveMatch[] = [];
    for (const row of group) {
      const identity = `${row.repo_id}\0${row.ecosystem}\0${row.name}\0${row.version}`;
      const existing = matches.find((m) => `${m.repoId}\0${m.ecosystem}\0${m.name}\0${m.version}` === identity);
      if (existing) {
        // Open if any record of it is still open; first seen when the earliest was.
        if (row.resolved_at === null) existing.resolvedAt = null;
        if (new Date(row.first_seen_at) < existing.firstSeenAt) existing.firstSeenAt = new Date(row.first_seen_at);
        continue;
      }
      matches.push({
        repoId: row.repo_id,
        repoFullName: row.repo_full_name,
        commitSha: row.commit_sha,
        advisoryId: row.advisory_id,
        ecosystem: row.ecosystem,
        name: row.name,
        version: row.version,
        manifest: row.manifest,
        direct: row.direct ?? false,
        dev: row.dev ?? false,
        usage: row.usage,
        approximate: row.approximate ?? false,
        importedAt: row.imported_at ?? [],
        firstSeenAt: new Date(row.first_seen_at),
        resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
        origin: row.origin,
      });
    }
    const open = matches.filter((m) => m.resolvedAt === null);
    const state: CveState = open.some(inCode) ? "in_code" : open.length > 0 ? "installed" : "resolved";
    matches.sort((a, b) => Number(b.resolvedAt === null) - Number(a.resolvedAt === null) || Number(inCode(b)) - Number(inCode(a)) || a.repoFullName.localeCompare(b.repoFullName) || a.name.localeCompare(b.name));
    const firstSeenAt = new Date(Math.min(...matches.map((m) => m.firstSeenAt.getTime())));
    const published = ranked.map((r) => r.publishedAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
    const fresh = state !== "resolved" && (now.getTime() - published < FRESH_MS || matches.some((m) => m.origin === "feed" && now.getTime() - m.firstSeenAt.getTime() < FRESH_MS));
    items.push({ key, primary, ids: ranked.map((r) => r.id), severity, state, matches, firstSeenAt, fresh });
  }
  return items.sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (b.primary.score ?? 0) - (a.primary.score ?? 0) ||
      b.firstSeenAt.getTime() - a.firstSeenAt.getTime() ||
      a.key.localeCompare(b.key),
  );
}

/** The vulnerability an OSV record describes: its lowest CVE id, else its GHSA id, else its own id. */
export function vulnKeyOf(id: string, aliases: string[]): string {
  const all = [id, ...aliases];
  const cves = all.filter((a) => /^CVE-\d{4}-\d+$/.test(a)).sort(compareCve);
  if (cves[0]) return cves[0];
  const ghsa = all.filter((a) => a.startsWith("GHSA-")).sort();
  return ghsa[0] ?? id;
}

function compareCve(a: string, b: string): number {
  const [, ay, an] = a.split("-");
  const [, by, bn] = b.split("-");
  return Number(ay) - Number(by) || Number(an) - Number(bn);
}
