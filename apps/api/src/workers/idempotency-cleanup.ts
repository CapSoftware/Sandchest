import { Context, Effect } from 'effect'
import type { WorkerConfig } from './runner.js'

const RETENTION_HOURS = 24

export interface IdempotencyRepoApi {
  /** Delete idempotency keys older than the given cutoff. Returns count deleted. */
  readonly deleteOlderThan: (
    cutoff: Date,
  ) => Effect.Effect<number, never, never>
}

export class IdempotencyRepo extends Context.Tag('IdempotencyRepo')<
  IdempotencyRepo,
  IdempotencyRepoApi
>() {}

export const idempotencyCleanupWorker: WorkerConfig<IdempotencyRepo> = {
  name: 'idempotency-cleanup',
  intervalMs: 5 * 60_000,
  handler: Effect.gen(function* () {
    const repo = yield* IdempotencyRepo
    const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000)
    const deleted = yield* repo.deleteOlderThan(cutoff)
    return deleted
  }),
}
