import { Effect } from 'effect'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { NodeClient } from '../services/node-client.js'
import { BillingService } from '../services/billing.js'
import { meterSandbox } from './credit-metering.js'
import type { WorkerConfig } from './runner.js'

export const ttlEnforcementWorker: WorkerConfig<SandboxRepo | NodeClient | BillingService> = {
  name: 'ttl-enforcement',
  intervalMs: 30_000,
  handler: Effect.gen(function* () {
    const repo = yield* SandboxRepo
    const nodeClient = yield* NodeClient
    const expired = yield* repo.findExpiredTtl()
    const now = new Date()

    for (const sandbox of expired) {
      // Final meter before termination
      yield* meterSandbox(sandbox, now).pipe(Effect.catchAll(() => Effect.void))

      yield* nodeClient.stopSandbox({ sandboxId: sandbox.id }).pipe(
        Effect.catchAll(() => Effect.void),
      )
      yield* repo.updateStatus(sandbox.id, sandbox.orgId, 'stopped', {
        endedAt: now,
        failureReason: 'ttl_exceeded',
      })
    }

    return expired.length
  }),
}
