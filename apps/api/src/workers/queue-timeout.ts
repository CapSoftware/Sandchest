import { Effect } from 'effect'
import { SandboxRepo } from '../services/sandbox-repo.js'
import type { WorkerConfig } from './runner.js'

const DEFAULT_QUEUE_TIMEOUT_SECONDS = 300

export const queueTimeoutWorker: WorkerConfig<SandboxRepo> = {
  name: 'queue-timeout',
  intervalMs: 5_000,
  handler: Effect.gen(function* () {
    const repo = yield* SandboxRepo
    const cutoff = new Date(Date.now() - DEFAULT_QUEUE_TIMEOUT_SECONDS * 1000)
    const timedOut = yield* repo.findQueuedBefore(cutoff)

    for (const sandbox of timedOut) {
      yield* repo.updateStatus(sandbox.id, sandbox.orgId, 'failed', {
        endedAt: new Date(),
        failureReason: 'queue_timeout',
      })
    }

    return timedOut.length
  }),
}
