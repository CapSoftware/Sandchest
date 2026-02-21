import { Effect } from 'effect'
import { SandboxRepo } from '../services/sandbox-repo.js'
import type { WorkerConfig } from './runner.js'

export const ttlEnforcementWorker: WorkerConfig<SandboxRepo> = {
  name: 'ttl-enforcement',
  intervalMs: 30_000,
  handler: Effect.gen(function* () {
    const repo = yield* SandboxRepo
    const expired = yield* repo.findExpiredTtl()

    for (const sandbox of expired) {
      yield* repo.updateStatus(sandbox.id, sandbox.orgId, 'stopped', {
        endedAt: new Date(),
        failureReason: 'ttl_exceeded',
      })
    }

    return expired.length
  }),
}
