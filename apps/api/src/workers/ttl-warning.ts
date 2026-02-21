import { Effect } from 'effect'
import { bytesToId, SANDBOX_PREFIX } from '@sandchest/contract'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { RedisService } from '../services/redis.js'
import { EventRecorder } from '../services/event-recorder.js'
import { sandboxTtlWarning } from '../services/events.js'
import type { WorkerConfig } from './runner.js'

/** Warn 60 seconds before TTL expiry. */
const WARNING_THRESHOLD_SECONDS = 60

/** Dedup key TTL — prevents re-warning the same sandbox for 120 seconds. */
const DEDUP_TTL_SECONDS = 120

export const ttlWarningWorker: WorkerConfig<SandboxRepo | RedisService | EventRecorder> = {
  name: 'ttl-warning',
  intervalMs: 10_000,
  handler: Effect.gen(function* () {
    const repo = yield* SandboxRepo
    const redis = yield* RedisService
    const recorder = yield* EventRecorder

    const nearExpiry = yield* repo.findNearTtlExpiry(WARNING_THRESHOLD_SECONDS)

    let warned = 0
    for (const sandbox of nearExpiry) {
      const sandboxId = bytesToId(SANDBOX_PREFIX, sandbox.id)
      const isNew = yield* redis.markTtlWarned(sandboxId, DEDUP_TTL_SECONDS)
      if (!isNew) continue

      const expiresAt = sandbox.startedAt!.getTime() + sandbox.ttlSeconds * 1000
      const secondsRemaining = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))

      yield* recorder.record({
        sandboxId,
        orgId: sandbox.orgId,
        event: sandboxTtlWarning({ seconds_remaining: secondsRemaining }),
      })

      warned++
    }

    return warned
  }),
}
