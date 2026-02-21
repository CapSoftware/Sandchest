import { Effect } from 'effect'
import { bytesToId, SANDBOX_PREFIX } from '@sandchest/contract'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { ObjectStorage } from '../services/object-storage.js'
import { QuotaService } from '../services/quota.js'
import type { WorkerConfig } from './runner.js'

/** Sentinel date used to mark replays as purged. Any replay_expires_at set to this value has already been cleaned up. */
export const PURGED_SENTINEL = new Date('2000-01-01T00:00:00.000Z')

const MS_PER_DAY = 86_400_000

export const replayRetentionWorker: WorkerConfig<SandboxRepo | ObjectStorage | QuotaService> = {
  name: 'replay-retention',
  intervalMs: 60 * 60_000,
  handler: Effect.gen(function* () {
    const sandboxRepo = yield* SandboxRepo
    const objectStorage = yield* ObjectStorage
    const quotaService = yield* QuotaService

    let processed = 0

    // Phase 1: Set replay_expires_at for terminal sandboxes missing it
    const missing = yield* sandboxRepo.findMissingReplayExpiry()
    const orgQuotaCache = new Map<string, number>()

    for (const row of missing) {
      let retentionDays = orgQuotaCache.get(row.orgId)
      if (retentionDays === undefined) {
        const quota = yield* quotaService.getOrgQuota(row.orgId)
        retentionDays = quota.replayRetentionDays
        orgQuotaCache.set(row.orgId, retentionDays)
      }

      const expiresAt = new Date(row.endedAt!.getTime() + retentionDays * MS_PER_DAY)
      yield* sandboxRepo.setReplayExpiresAt(row.id, expiresAt)
      processed++
    }

    // Phase 2: Purge expired replays (delete events from object storage)
    const now = new Date()
    const expired = yield* sandboxRepo.findPurgableReplays(now, PURGED_SENTINEL)

    for (const row of expired) {
      const sandboxId = bytesToId(SANDBOX_PREFIX, row.id)
      const eventsKey = `${row.orgId}/${sandboxId}/events.jsonl`
      yield* objectStorage.deleteObject(eventsKey).pipe(
        Effect.catchAll(() => Effect.void),
      )

      // Mark as purged by setting to sentinel date
      yield* sandboxRepo.setReplayExpiresAt(row.id, PURGED_SENTINEL)
      processed++
    }

    return processed
  }),
}
