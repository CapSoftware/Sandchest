import { Effect, Layer } from 'effect'
import { eq, lt, desc } from 'drizzle-orm'
import type { Database } from '@sandchest/db/client'
import { nodeMetrics } from '@sandchest/db/schema'
import { generateUUIDv7 } from '@sandchest/contract'
import { MetricsRepo, type MetricsRow, type MetricsRepoApi } from './metrics-repo.js'

/** Map a raw Drizzle row from the node_metrics table to a MetricsRow. */
function toMetricsRow(row: typeof nodeMetrics.$inferSelect): MetricsRow {
  return {
    id: row.id,
    nodeId: row.nodeId,
    cpuPercent: row.cpuPercent,
    memoryUsedBytes: row.memoryUsedBytes,
    memoryTotalBytes: row.memoryTotalBytes,
    diskUsedBytes: row.diskUsedBytes,
    diskTotalBytes: row.diskTotalBytes,
    networkRxBytes: row.networkRxBytes,
    networkTxBytes: row.networkTxBytes,
    loadAvg1: row.loadAvg1,
    loadAvg5: row.loadAvg5,
    loadAvg15: row.loadAvg15,
    createdAt: row.createdAt,
  }
}

export function createDrizzleMetricsRepo(db: Database): MetricsRepoApi {
  return {
    insert: (metrics) =>
      Effect.promise(async () => {
        await db.insert(nodeMetrics).values({
          id: generateUUIDv7(),
          nodeId: metrics.nodeId,
          cpuPercent: metrics.cpuPercent,
          memoryUsedBytes: metrics.memoryUsedBytes,
          memoryTotalBytes: metrics.memoryTotalBytes,
          diskUsedBytes: metrics.diskUsedBytes,
          diskTotalBytes: metrics.diskTotalBytes,
          networkRxBytes: metrics.networkRxBytes,
          networkTxBytes: metrics.networkTxBytes,
          loadAvg1: metrics.loadAvg1,
          loadAvg5: metrics.loadAvg5,
          loadAvg15: metrics.loadAvg15,
        })
      }),

    getRecent: (nodeId, limit) =>
      Effect.promise(async () => {
        const rows = await db
          .select()
          .from(nodeMetrics)
          .where(eq(nodeMetrics.nodeId, nodeId))
          .orderBy(desc(nodeMetrics.createdAt))
          .limit(limit)
        return rows.map(toMetricsRow)
      }),

    deleteOlderThan: (cutoff) =>
      Effect.promise(async () => {
        const result = await db
          .delete(nodeMetrics)
          .where(lt(nodeMetrics.createdAt, cutoff))
        return (result as unknown as [{ affectedRows: number }])[0].affectedRows
      }),
  }
}

export const makeMetricsRepoDrizzle = (db: Database) =>
  Layer.sync(MetricsRepo, () => createDrizzleMetricsRepo(db))
