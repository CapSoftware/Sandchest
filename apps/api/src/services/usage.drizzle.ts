import { Effect, Layer } from 'effect'
import { eq, and, gte, lt, asc, sql } from 'drizzle-orm'
import type { Database } from '@sandchest/db/client'
import { orgUsage } from '@sandchest/db/schema'
import { UsageService, type UsageApi, type UsagePeriod, type UsageSummary } from './usage.js'

const EMPTY_SUMMARY: UsageSummary = { sandboxMinutes: 0, execCount: 0, storageBytes: 0 }

/** Returns the start of the UTC day for a given date. */
function utcDayStart(date: Date): Date {
  const d = new Date(date)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

function toUsagePeriod(row: typeof orgUsage.$inferSelect): UsagePeriod {
  return {
    orgId: row.orgId,
    periodStart: row.periodStart,
    sandboxMinutes: row.sandboxMinutes,
    execCount: row.execCount,
    storageBytes: row.storageBytes,
  }
}

export function createDrizzleUsageApi(db: Database): UsageApi {
  return {
    recordSandboxMinutes: (orgId, minutes) =>
      Effect.promise(async () => {
        const periodStart = utcDayStart(new Date())
        await db
          .insert(orgUsage)
          .values({
            orgId,
            periodStart,
            sandboxMinutes: minutes,
            execCount: 0,
            storageBytes: 0,
          })
          .onDuplicateKeyUpdate({
            set: {
              sandboxMinutes: sql`${orgUsage.sandboxMinutes} + ${minutes}`,
              updatedAt: new Date(),
            },
          })
      }),

    recordExec: (orgId, count) =>
      Effect.promise(async () => {
        const periodStart = utcDayStart(new Date())
        const increment = count ?? 1
        await db
          .insert(orgUsage)
          .values({
            orgId,
            periodStart,
            sandboxMinutes: 0,
            execCount: increment,
            storageBytes: 0,
          })
          .onDuplicateKeyUpdate({
            set: {
              execCount: sql`${orgUsage.execCount} + ${increment}`,
              updatedAt: new Date(),
            },
          })
      }),

    recordStorageBytes: (orgId, bytes) =>
      Effect.promise(async () => {
        const periodStart = utcDayStart(new Date())
        await db
          .insert(orgUsage)
          .values({
            orgId,
            periodStart,
            sandboxMinutes: 0,
            execCount: 0,
            storageBytes: bytes,
          })
          .onDuplicateKeyUpdate({
            set: {
              storageBytes: sql`${orgUsage.storageBytes} + ${bytes}`,
              updatedAt: new Date(),
            },
          })
      }),

    getCurrentPeriodUsage: (orgId) =>
      Effect.promise(async () => {
        const periodStart = utcDayStart(new Date())
        const [row] = await db
          .select()
          .from(orgUsage)
          .where(
            and(
              eq(orgUsage.orgId, orgId),
              eq(orgUsage.periodStart, periodStart),
            ),
          )
          .limit(1)

        if (!row) return EMPTY_SUMMARY

        return {
          sandboxMinutes: row.sandboxMinutes,
          execCount: row.execCount,
          storageBytes: row.storageBytes,
        }
      }),

    getUsage: (orgId, from, to) =>
      Effect.promise(async () => {
        const [result] = await db
          .select({
            sandboxMinutes: sql<number>`COALESCE(SUM(${orgUsage.sandboxMinutes}), 0)`,
            execCount: sql<number>`COALESCE(SUM(${orgUsage.execCount}), 0)`,
            storageBytes: sql<number>`COALESCE(SUM(${orgUsage.storageBytes}), 0)`,
          })
          .from(orgUsage)
          .where(
            and(
              eq(orgUsage.orgId, orgId),
              gte(orgUsage.periodStart, from),
              lt(orgUsage.periodStart, to),
            ),
          )

        if (!result) return EMPTY_SUMMARY

        return {
          sandboxMinutes: Number(result.sandboxMinutes),
          execCount: Number(result.execCount),
          storageBytes: Number(result.storageBytes),
        }
      }),

    getUsageByPeriod: (orgId, from, to) =>
      Effect.promise(async () => {
        const rows = await db
          .select()
          .from(orgUsage)
          .where(
            and(
              eq(orgUsage.orgId, orgId),
              gte(orgUsage.periodStart, from),
              lt(orgUsage.periodStart, to),
            ),
          )
          .orderBy(asc(orgUsage.periodStart))

        return rows.map(toUsagePeriod)
      }),
  }
}

export const makeUsageDrizzle = (db: Database) =>
  Layer.sync(UsageService, () => createDrizzleUsageApi(db))
