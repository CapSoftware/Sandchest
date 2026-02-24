import { Context, type Effect } from 'effect'

export interface MetricsRow {
  readonly id: Uint8Array
  readonly nodeId: Uint8Array
  readonly cpuPercent: number
  readonly memoryUsedBytes: bigint
  readonly memoryTotalBytes: bigint
  readonly diskUsedBytes: bigint
  readonly diskTotalBytes: bigint
  readonly networkRxBytes: bigint
  readonly networkTxBytes: bigint
  readonly loadAvg1: number
  readonly loadAvg5: number
  readonly loadAvg15: number
  readonly createdAt: Date
}

export interface MetricsInput {
  readonly nodeId: Uint8Array
  readonly cpuPercent: number
  readonly memoryUsedBytes: bigint
  readonly memoryTotalBytes: bigint
  readonly diskUsedBytes: bigint
  readonly diskTotalBytes: bigint
  readonly networkRxBytes: bigint
  readonly networkTxBytes: bigint
  readonly loadAvg1: number
  readonly loadAvg5: number
  readonly loadAvg15: number
}

export interface MetricsRepoApi {
  readonly insert: (metrics: MetricsInput) => Effect.Effect<void, never, never>

  readonly getRecent: (
    nodeId: Uint8Array,
    limit: number,
  ) => Effect.Effect<MetricsRow[], never, never>

  readonly deleteOlderThan: (cutoff: Date) => Effect.Effect<number, never, never>
}

export class MetricsRepo extends Context.Tag('MetricsRepo')<MetricsRepo, MetricsRepoApi>() {}
