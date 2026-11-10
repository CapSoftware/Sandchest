/**
 * The usage ledger: one row per model call and one per sandbox, each with
 * its exact cost. Records only; nothing here changes what anyone is charged.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import type { ScanStatus } from "./queries";
import { scanMetrics, scans, scanUsage, type UsageCostSource, type UsageKind, type UsageStatus } from "./schema";

export type UsageRow = typeof scanUsage.$inferSelect;

export interface UsageInput {
  kind: UsageKind;
  stage: string;
  role?: string | null;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  /** Machine time, for sandbox rows. */
  seconds?: number | string | null;
  /** USD. A number is stored to the column's 10 decimal places. */
  costUsd: number | string;
  costSource: UsageCostSource;
  /** Which run of its step made the call. Default 0. */
  attempt?: number;
  /** How the call ended. Default `ok`. */
  status?: UsageStatus;
  /** When the call finished. Defaults to the time of the insert. */
  createdAt?: Date;
}

/** Rows per insert, well under Postgres's parameter limit. */
const INSERT_BATCH = 500;

/** Appends rows to a scan's ledger. */
export async function insertUsage(database: Db, scanId: string, rows: UsageInput[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    await database.insert(scanUsage).values(
      rows.slice(i, i + INSERT_BATCH).map((row) => ({
        scanId,
        kind: row.kind,
        stage: row.stage,
        role: row.role ?? null,
        inputTokens: row.inputTokens ?? 0,
        cachedTokens: row.cachedTokens ?? 0,
        outputTokens: row.outputTokens ?? 0,
        reasoningTokens: row.reasoningTokens ?? 0,
        seconds: row.seconds == null ? null : typeof row.seconds === "number" ? row.seconds.toFixed(3) : row.seconds,
        costUsd: typeof row.costUsd === "number" ? row.costUsd.toFixed(10) : row.costUsd,
        costSource: row.costSource,
        attempt: row.attempt ?? 0,
        status: row.status ?? "ok",
        ...(row.createdAt && { createdAt: row.createdAt }),
      })),
    );
  }
}

/** A scan's ledger in the order it was spent. Decimals come back as exact strings. */
export async function scanUsageRows(database: Db, scanId: string): Promise<UsageRow[]> {
  return database.select().from(scanUsage).where(eq(scanUsage.scanId, scanId)).orderBy(asc(scanUsage.createdAt), asc(scanUsage.id));
}

export interface UsageTotal {
  kind: UsageKind;
  stage: string;
  requests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Exact decimal string; null when no row had any. */
  seconds: string | null;
  /** Exact decimal string. */
  costUsd: string;
}

/** A scan's totals per kind and stage. */
export async function scanUsageTotals(database: Db, scanId: string): Promise<UsageTotal[]> {
  return database
    .select({
      kind: scanUsage.kind,
      stage: scanUsage.stage,
      requests: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${scanUsage.inputTokens}), 0)::bigint`.mapWith(Number),
      cachedTokens: sql<number>`coalesce(sum(${scanUsage.cachedTokens}), 0)::bigint`.mapWith(Number),
      outputTokens: sql<number>`coalesce(sum(${scanUsage.outputTokens}), 0)::bigint`.mapWith(Number),
      reasoningTokens: sql<number>`coalesce(sum(${scanUsage.reasoningTokens}), 0)::bigint`.mapWith(Number),
      seconds: sql<string | null>`sum(${scanUsage.seconds})::text`,
      costUsd: sql<string>`coalesce(sum(${scanUsage.costUsd}), 0)::text`,
    })
    .from(scanUsage)
    .where(eq(scanUsage.scanId, scanId))
    .groupBy(scanUsage.kind, scanUsage.stage)
    .orderBy(asc(scanUsage.kind), asc(scanUsage.stage));
}

/** What the scan's sandbox cost, beside its model cost. A scan with no metrics row yet is left alone. */
export async function setComputeCost(database: Db, scanId: string, usd: number): Promise<void> {
  await database.update(scanMetrics).set({ computeCostUsd: usd.toFixed(6) }).where(eq(scanMetrics.scanId, scanId));
}

// ---- Calls metered one at a time (the model gateway) ------------------------

/**
 * Opens the row of a model call that is about to be made, as `started` with no cost, and returns its
 * id. `finishUsageCall` closes it. A row that stays `started` is a call whose outcome was never seen.
 */
export async function startUsageCall(database: Db, scanId: string, call: { stage: string; role?: string | null; attempt?: number }): Promise<number> {
  const [row] = await database
    .insert(scanUsage)
    .values({ scanId, kind: "model", stage: call.stage, role: call.role ?? null, attempt: call.attempt ?? 0, status: "started", costUsd: "0", costSource: "provider" })
    .returning({ id: scanUsage.id });
  if (!row) throw new Error("The usage row was not written");
  return row.id;
}

export interface UsageCallResult {
  status: Exclude<UsageStatus, "started">;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  /** USD, as the endpoint reported it. A number is stored to the column's 10 decimal places. */
  costUsd: number | string;
}

/** Closes a row `startUsageCall` opened. Only a `started` row changes, so closing twice writes once. False when nothing changed. */
export async function finishUsageCall(database: Db, id: number, result: UsageCallResult): Promise<boolean> {
  const rows = await database
    .update(scanUsage)
    .set({
      status: result.status,
      inputTokens: result.inputTokens ?? 0,
      cachedTokens: result.cachedTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      reasoningTokens: result.reasoningTokens ?? 0,
      costUsd: typeof result.costUsd === "number" ? result.costUsd.toFixed(10) : result.costUsd,
    })
    .where(and(eq(scanUsage.id, id), eq(scanUsage.status, "started")))
    .returning({ id: scanUsage.id });
  return rows.length === 1;
}

/** Where a scan's spending stands, for deciding whether it may make another model call. */
export interface UsageBudgetState {
  scanStatus: ScanStatus;
  /** Everything in the scan's ledger, every attempt included. Exact decimal string. */
  spentUsd: string;
  /** Calls under way: `started` rows no older than `staleAfterSeconds`. */
  inFlight: number;
  /** `started` rows older than that: calls whose outcome was never recorded. */
  lost: number;
  /** Calls that finished with no cost reported. */
  unpriced: number;
  /** Calls that broke off with no cost reported. */
  abortedUnpriced: number;
}

/** Undefined when there is no such scan. One query. */
export async function usageBudgetState(database: Db, scanId: string, staleAfterSeconds: number): Promise<UsageBudgetState | undefined> {
  const stale = sql`${scanUsage.createdAt} < now() - make_interval(secs => ${staleAfterSeconds})`;
  const [row] = await database
    .select({
      scanStatus: scans.status,
      spentUsd: sql<string>`coalesce(sum(${scanUsage.costUsd}), 0)::text`,
      inFlight: sql<number>`(count(*) filter (where ${scanUsage.status} = 'started' and not ${stale}))::int`,
      lost: sql<number>`(count(*) filter (where ${scanUsage.status} = 'started' and ${stale}))::int`,
      unpriced: sql<number>`(count(*) filter (where ${scanUsage.status} = 'unpriced'))::int`,
      abortedUnpriced: sql<number>`(count(*) filter (where ${scanUsage.status} = 'aborted' and ${scanUsage.costUsd} = 0))::int`,
    })
    .from(scans)
    .leftJoin(scanUsage, eq(scanUsage.scanId, scans.id))
    .where(eq(scans.id, scanId))
    .groupBy(scans.id);
  return row;
}
