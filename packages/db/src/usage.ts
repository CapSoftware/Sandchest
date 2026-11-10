/**
 * The usage ledger: one row per model call and one per sandbox, each with
 * its exact cost. Records only; nothing here changes what anyone is charged.
 */
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { scanMetrics, scanUsage, type UsageCostSource, type UsageKind } from "./schema";

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
