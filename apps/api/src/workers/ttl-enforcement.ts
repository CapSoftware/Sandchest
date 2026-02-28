import { Effect } from 'effect'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { NodeClient } from '../services/node-client.js'
import type { WorkerConfig } from './runner.js'

export const ttlEnforcementWorker: WorkerConfig<SandboxRepo | NodeClient> = {
  name: 'ttl-enforcement',
  intervalMs: 30_000,
  handler: Effect.gen(function* () {
    const repo = yield* SandboxRepo
    const nodeClient = yield* NodeClient
    const expired = yield* repo.findExpiredTtl()

    for (const sandbox of expired) {
      yield* nodeClient.stopSandbox({ sandboxId: sandbox.id }).pipe(
        Effect.catchAll(() => Effect.void),
      )
      yield* repo.updateStatus(sandbox.id, sandbox.orgId, 'stopped', {
        endedAt: new Date(),
        failureReason: 'ttl_exceeded',
      })
    }

    return expired.length
  }),
}
