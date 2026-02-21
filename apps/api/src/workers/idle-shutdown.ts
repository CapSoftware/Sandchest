import { Effect } from 'effect'
import { SandboxRepo } from '../services/sandbox-repo.js'
import type { WorkerConfig } from './runner.js'

const DEFAULT_IDLE_TIMEOUT_SECONDS = 900

export const idleShutdownWorker: WorkerConfig<SandboxRepo> = {
  name: 'idle-shutdown',
  intervalMs: 60_000,
  handler: Effect.gen(function* () {
    const repo = yield* SandboxRepo
    const cutoff = new Date(Date.now() - DEFAULT_IDLE_TIMEOUT_SECONDS * 1000)
    const idle = yield* repo.findIdleSince(cutoff)

    for (const sandbox of idle) {
      yield* repo.updateStatus(sandbox.id, sandbox.orgId, 'stopped', {
        endedAt: new Date(),
        failureReason: 'idle_timeout',
      })
    }

    return idle.length
  }),
}
