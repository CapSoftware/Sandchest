import { Effect } from 'effect'
import { MetricsRepo } from '../services/metrics-repo.js'
import type { WorkerConfig } from './runner.js'

const RETENTION_DAYS = 7

export const metricsRetentionWorker: WorkerConfig<MetricsRepo> = {
  name: 'metrics-retention',
  intervalMs: 60_000,
  handler: Effect.gen(function* () {
    const metricsRepo = yield* MetricsRepo
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    const deleted = yield* metricsRepo.deleteOlderThan(cutoff)
    return deleted
  }),
}
