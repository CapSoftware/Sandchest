/**
 * Stage timings: when each stage of a scan started and ended, every run of it. Times and outcomes
 * only. Writes are idempotent, so a step that is run again can write them again.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./client";
import { scanStages, type StageOutcome } from "./schema";

export type StageRow = typeof scanStages.$inferSelect;

export interface StageRun {
  stage: string;
  /** Which run of the stage. Default 0. */
  attempt?: number;
}

/** Opens a stage. A repeat keeps the first start. */
export async function startStage(database: Db, scanId: string, run: StageRun & { at: Date }): Promise<void> {
  await database
    .insert(scanStages)
    .values({ scanId, stage: run.stage, attempt: run.attempt ?? 0, startedAt: run.at })
    .onConflictDoNothing({ target: [scanStages.scanId, scanStages.stage, scanStages.attempt] });
}

/** Closes a stage that was opened. Only an open stage changes, so a stage ends once. False when nothing changed. */
export async function endStage(database: Db, scanId: string, run: StageRun & { at: Date; outcome: StageOutcome }): Promise<boolean> {
  const rows = await database
    .update(scanStages)
    .set({ endedAt: run.at, outcome: run.outcome })
    .where(and(eq(scanStages.scanId, scanId), eq(scanStages.stage, run.stage), eq(scanStages.attempt, run.attempt ?? 0), isNull(scanStages.endedAt)))
    .returning({ id: scanStages.id });
  return rows.length === 1;
}

/** A whole stage in one write: opened and closed, or closed if it was open. The first start and the first end are kept. */
export async function recordStage(database: Db, scanId: string, run: StageRun & { startedAt: Date; endedAt: Date; outcome: StageOutcome }): Promise<void> {
  await database
    .insert(scanStages)
    .values({ scanId, stage: run.stage, attempt: run.attempt ?? 0, startedAt: run.startedAt, endedAt: run.endedAt, outcome: run.outcome })
    .onConflictDoUpdate({
      target: [scanStages.scanId, scanStages.stage, scanStages.attempt],
      set: { endedAt: sql`excluded.ended_at`, outcome: sql`excluded.outcome` },
      setWhere: isNull(scanStages.endedAt),
    });
}

/** A scan's stages in the order they started. */
export async function scanStageRows(database: Db, scanId: string): Promise<StageRow[]> {
  return database.select().from(scanStages).where(eq(scanStages.scanId, scanId)).orderBy(asc(scanStages.startedAt), asc(scanStages.id));
}
