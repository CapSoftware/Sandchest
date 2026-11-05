/**
 * The CVE directory's moving parts. Each repository's dependency inventory is
 * read from its default branch (during scans, and by a free refresh when a
 * push changes a manifest or lockfile) and kept between scans, so OSV can be
 * asked about it at any time without the code:
 *
 * - every minute, the OSV change feed says which advisories were published
 *   or changed; installed versions of the packages they name are checked
 *   again, so a new CVE shows up within a minute or two of OSV having it;
 * - once a day, every inventory is checked in full: the safety net for
 *   anything the feed missed;
 * - reading an inventory checks it at once.
 *
 * OSV decides which advisories affect a version. Only package names and
 * versions leave Sandchest; never code.
 */
import {
  applyMatches,
  claimInventoryRefresh,
  exclusiveFeedSync,
  feedCursors,
  installedVersions,
  inventoriesDue,
  inventoriesUnchecked,
  inventoryPackages,
  inventoryRepo,
  markInventoriesChecked,
  matchKey,
  releaseInventoryRefresh,
  saveInventory,
  setFeedCursor,
  storedAdvisories,
  upsertAdvisories,
  vulnKeyOf,
  type AdvisoryRow,
  type NewMatch,
  type PackageVersion,
} from "@sandchest/db";
import { affectedNames, packageKey, resolveMaven, stampMs, toAdvisoryRecord, toInventory, type AdvisoryRecord, type Change, type JvmImport, type Managed, type OsvRecord } from "@sandchest/engine/advisories";
import { createIndexerClient, type IndexerClient } from "@sandchest/engine/indexer";
import { LocalWorkspace } from "@sandchest/workspace/local";
import { SandboxWorkspace } from "@sandchest/workspace/sandbox";
import { config } from "./config";
import { describeError } from "./log";
import { indexerBinary, prepareWorkspace } from "./scans";
import { catalog, db, githubApp, maven } from "./services";

/** The feed is re-read this far behind its cursor: OSV can publish a record stamped a little earlier than one already read. */
const FEED_OVERLAP_MS = 2 * 3_600_000;
/** Changes handled per ecosystem per sweep. */
const FEED_MAX_CHANGES = 2_000;
/** Every inventory is checked in full at least this often. */
const RECHECK_MS = 24 * 3_600_000;
/** Records are fetched from OSV's public bucket, which serves this many at once without strain. */
const RECORD_CONCURRENCY = 24;
/** Ecosystem feeds read at once. */
const FEED_CONCURRENCY = 4;
/** Per sweep (every ten minutes): inventories read, and inventories checked in full. */
const REFRESHES_PER_SWEEP = 5;
const RECHECKS_PER_SWEEP = 12;
const REFRESH_BUDGET_MS = 8 * 60_000;
/** Reading the versions a JVM project's parent and BOMs set, and what its artifacts pull in, from Maven Central. */
const MAVEN_BUDGET_MS = 3 * 60_000;

type Dependency = Parameters<typeof toInventory>[0][number];
/** The indexer's `deps`: what the files pin, and what only Maven Central can put a version on. */
type Read = { dependencies: Dependency[]; managed?: Managed[]; jvmImports?: JvmImport[] };

/** Everything a read says is installed, Maven artifacts resolved. */
async function installed({ dependencies, managed = [], jvmImports = [] }: Read): Promise<Dependency[]> {
  const resolved = await resolveMaven(maven(), { dependencies, managed, imports: jvmImports }, AbortSignal.timeout(MAVEN_BUDGET_MS));
  return [...dependencies, ...resolved];
}

// ---- Inventories ------------------------------------------------------------

/**
 * Saves the inventory an indexer read from `commitSha` and checks it against
 * OSV. A read older than the stored one is dropped.
 */
export async function saveDependencies(repoId: string, commitSha: string, startedAt: Date, dependencies: Dependency[]): Promise<{ saved: boolean; added: number }> {
  const saved = await saveInventory(db(), repoId, commitSha, startedAt, toInventory(dependencies));
  if (!saved) return { saved, added: 0 };
  const added = await checkRepository(repoId, "inventory");
  return { saved, added: added.length };
}

/**
 * Reads the inventory from a scan's indexer while the scan runs, so the
 * workspace is never kept for it. Never throws: the scan must not fail
 * because the directory couldn't be updated. `pinnedAt` is when the scan's
 * commit was chosen (never later than that): a scan that waited in the queue
 * holds an older commit than a refresh that ran meanwhile, and must not
 * overwrite it.
 */
export function captureFromScan(repoId: string, commitSha: string, pinnedAt: Date, indexer: IndexerClient): { read: Promise<unknown>; done: Promise<void> } {
  const startedAt = pinnedAt;
  const read = indexer.call<Read>("deps", {});
  const done = read
    .then(installed)
    .then((dependencies) => saveDependencies(repoId, commitSha, startedAt, dependencies))
    .then(
      () => undefined,
      (error: unknown) => console.error(`Inventory for repo ${repoId} not saved: ${describeError(error)}`),
    );
  return { read: read.catch(() => undefined), done };
}

/**
 * Checks every package a repository installs against OSV and records what
 * affects it. Returns the matches that are new.
 */
export async function checkRepository(repoId: string, origin: "feed" | "inventory"): Promise<NewMatch[]> {
  const started = new Date();
  const packages = await inventoryPackages(db(), repoId);
  const results = packages.length > 0 ? await catalog().matches(packages) : [];
  await storeRecords(packages.flatMap((pkg, i) => (results[i] ?? []).map((change) => ({ ...change, ecosystem: pkg.ecosystem }))));
  const matches = new Map(packages.map((pkg, i) => [matchKey(pkg), (results[i] ?? []).map((change) => change.id)]));
  const added = await applyMatches(db(), { checked: packages, matches, origin, repoId });
  await markInventoriesChecked(db(), [repoId], started);
  return added;
}

/**
 * Reads a repository's inventory in a fresh workspace: clone, index, read
 * dependencies, throw the workspace away. No model, no credits. Returns
 * "busy" when another refresh holds the repository.
 */
export async function refreshInventory(repoId: string): Promise<{ state: "busy" | "gone" | "done"; dependencies?: number }> {
  if (!(await claimInventoryRefresh(db(), repoId))) return { state: "busy" };
  try {
    const repo = await inventoryRepo(db(), repoId);
    if (!repo?.enabled || !repo.org.installationId) {
      await releaseInventoryRefresh(db(), repoId);
      return { state: "gone" };
    }
    const installation = githubApp().installation(repo.org.installationId);
    const settings = config();
    const startedAt = new Date();
    const url = `${(settings.SANDCHEST_GIT_HOST ?? "https://github.com").replace(/\/$/, "")}/${repo.fullName}.git`;
    const { workspace, headSha, handle } = await prepareWorkspace({
      open: () => (settings.workspace === "sandbox" ? SandboxWorkspace.create({ timeoutMs: REFRESH_BUDGET_MS }) : LocalWorkspace.create()),
      clone: async (ready) => ready.clone({ url, ref: "HEAD" }, { depth: 1, token: await installation.cloneToken(repo.githubRepoId), timeoutMs: 4 * 60_000 }),
      binary: indexerBinary(settings.workspace),
      started: startedAt.getTime(),
      onRetry: () => {},
    });
    let read: Read;
    try {
      read = await createIndexerClient({ url: handle.url, token: handle.token }).call<Read>("deps", {});
    } finally {
      await workspace.destroy().catch(() => {});
    }
    const dependencies = await installed(read);
    await saveDependencies(repoId, headSha, startedAt, dependencies);
    await releaseInventoryRefresh(db(), repoId);
    return { state: "done", dependencies: dependencies.length };
  } catch (error) {
    await releaseInventoryRefresh(db(), repoId, describeError(error)).catch(() => {});
    throw error;
  }
}

// ---- Advisories -------------------------------------------------------------

/**
 * Stores the records behind these changes that are new or changed since they
 * were stored. A record OSV can't serve is skipped (its match waits for the
 * next check); a record with no rating borrows its GitHub alias's.
 */
async function storeRecords(changes: Array<Change & { ecosystem?: string }>, known: Map<string, OsvRecord> = new Map()): Promise<void> {
  const latest = new Map<string, Change & { ecosystem?: string }>();
  for (const change of changes) if (!latest.has(change.id)) latest.set(change.id, change);
  if (latest.size === 0) return;
  const stored = await storedAdvisories(db(), [...latest.keys()]);
  const stale = [...latest.values()].filter((change) => {
    const at = stored.get(change.id);
    return !at || (stampMs(change.modified) ?? Number.POSITIVE_INFINITY) > at.getTime();
  });
  const rows = (await mapLimit(stale, RECORD_CONCURRENCY, async (change) => {
    const osv = known.get(change.id) ?? (await catalog().record(change.id, change.ecosystem));
    return osv ? toRow(await rated(toAdvisoryRecord(osv))) : undefined;
  })).filter((row): row is AdvisoryRow => row !== undefined);
  await upsertAdvisories(db(), rows);
}

/** A record with no rating of its own takes its GitHub alias's (Go and PyPI records often have none). */
async function rated(record: AdvisoryRecord): Promise<AdvisoryRecord> {
  if (record.severity !== "unknown") return record;
  const alias = record.aliases.find((id) => id.startsWith("GHSA-"));
  if (!alias) return record;
  const other = await catalog()
    .record(alias)
    .catch(() => undefined);
  if (!other) return record;
  const borrowed = toAdvisoryRecord(other);
  return borrowed.severity === "unknown" ? record : { ...record, severity: borrowed.severity, score: record.score ?? borrowed.score, vector: record.vector ?? borrowed.vector };
}

function toRow(record: AdvisoryRecord): AdvisoryRow {
  return {
    id: record.id,
    vulnKey: vulnKeyOf(record.id, record.aliases),
    aliases: record.aliases,
    summary: record.summary,
    details: record.details,
    severity: record.severity,
    score: record.score,
    vector: record.vector,
    malicious: record.malicious,
    affected: record.affected,
    references: record.references,
    publishedAt: record.publishedAt ? new Date(record.publishedAt) : null,
    modifiedAt: new Date(stampMs(record.modifiedAt) ?? Date.now()),
    withdrawnAt: record.withdrawnAt ? new Date(record.withdrawnAt) : null,
  };
}

export interface SyncResult {
  changed: number;
  packages: number;
  added: NewMatch[];
  errors: string[];
}

/**
 * Reads the OSV change feed of every ecosystem an inventory installs from, from where the last sync
 * stopped, refreshes the stored records that changed, and checks every installed version of the packages
 * they name.
 */
export async function syncAdvisories(): Promise<SyncResult> {
  const result: SyncResult = { changed: 0, packages: 0, added: [], errors: [] };
  await mapLimit(await feedCursors(db()), FEED_CONCURRENCY, async ({ ecosystem, cursor, handled }) => {
    try {
      // The overlap behind the cursor is read again for records OSV stamped late; what was handled there is skipped.
      const read = await catalog().changedSince(ecosystem, cursor - FEED_OVERLAP_MS);
      const unseen = read.changes.filter((change) => !handled.has(seenKey(change)));
      // Nothing new: nothing is fetched, checked or written.
      if (unseen.length === 0) return;
      // Newest first. A burst bigger than one sync should take (OSV re-stamping an ecosystem) is handled up
      // to the cap and the cursor moves past the rest: the daily full check of every inventory covers them.
      const changes = unseen.slice(0, FEED_MAX_CHANGES);
      const newestRead = Math.max(cursor, ...unseen.slice(0, 1).map((change) => stampMs(change.modified) ?? 0));
      const window = read.changes.filter((change) => (stampMs(change.modified) ?? 0) >= newestRead - FEED_OVERLAP_MS).map(seenKey);
      result.changed += changes.length;
      const records = new Map<string, OsvRecord>();
      await mapLimit(changes, RECORD_CONCURRENCY, async (change) => {
        const record = await catalog().record(change.id, ecosystem);
        if (record) records.set(change.id, record);
      });
      // Which installed packages the changes name, by the name advisories use.
      const keys = new Map<string, { ecosystem: string; key: string }>();
      for (const record of records.values()) {
        for (const name of affectedNames(record, ecosystem)) {
          const key = packageKey(ecosystem, name);
          keys.set(key, { ecosystem, key });
        }
      }
      const installed = await installedVersions(db(), [...keys.values()]);
      // Records already stored are refreshed whether or not anything installs them now (a withdrawal, a corrected range).
      const stored = await storedAdvisories(db(), [...records.keys()]);
      await storeRecords(
        changes.filter((change) => stored.has(change.id)).map((change) => ({ ...change, ecosystem })),
        records,
      );
      if (installed.length > 0) {
        result.packages += installed.length;
        result.added.push(...(await checkPackages(installed, "feed", records)));
      }
      await setFeedCursor(db(), ecosystem, newestRead, window);
    } catch (error) {
      result.errors.push(`${ecosystem}: ${describeError(error)}`);
    }
  });
  return result;
}

function seenKey(change: Change): string {
  return `${change.id}@${change.modified}`;
}

/** Checks these installed versions against OSV across every repository that installs them. */
async function checkPackages(packages: PackageVersion[], origin: "feed" | "inventory", known?: Map<string, OsvRecord>): Promise<NewMatch[]> {
  const results = await catalog().matches(packages);
  await storeRecords(
    packages.flatMap((pkg, i) => (results[i] ?? []).map((change) => ({ ...change, ecosystem: pkg.ecosystem }))),
    known,
  );
  const matches = new Map(packages.map((pkg, i) => [matchKey(pkg), (results[i] ?? []).map((change) => change.id)]));
  return applyMatches(db(), { checked: packages, matches, origin });
}

// ---- The sweep ----------------------------------------------------------------

/** Follows the feeds, once a minute. Skipped while the previous sync is still running. */
export async function followFeeds(): Promise<SyncResult | { skipped: true }> {
  const result = await exclusiveFeedSync(db(), syncAdvisories);
  if (!result) return { skipped: true };
  for (const error of result.errors) console.error(`OSV feed: ${error}`);
  return result;
}

/** The CVE directory's share of the ten-minute sweep: inventories to read, and inventories due their daily full check. */
export async function sweepCves(startInventory: (repoId: string) => Promise<void>, now = new Date()): Promise<{ refreshed: number; rechecked: number; errors: number }> {
  const [due, unchecked] = await Promise.all([inventoriesDue(db(), REFRESHES_PER_SWEEP), inventoriesUnchecked(db(), new Date(now.getTime() - RECHECK_MS), RECHECKS_PER_SWEEP)]);
  const started = await Promise.allSettled(due.map((repoId) => startInventory(repoId)));
  // A first check that failed when the inventory was read is still the inventory's; later ones find new advisories.
  const rechecked = await mapLimit(unchecked, 3, ({ repoId, checkedAt }) =>
    checkRepository(repoId, checkedAt ? "feed" : "inventory").then(
      () => true,
      (error: unknown) => {
        console.error(`Checking repo ${repoId} against OSV failed: ${describeError(error)}`);
        return false;
      },
    ),
  );
  return {
    refreshed: started.filter((r) => r.status === "fulfilled").length,
    rechecked: rechecked.filter(Boolean).length,
    errors: started.filter((r) => r.status === "rejected").length + rechecked.filter((ok) => !ok).length,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}
