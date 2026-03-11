import { Effect } from 'effect'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { NodeClient } from '../services/node-client.js'
import type { BillingService } from '../services/billing.js'
import { meterSandbox } from './credit-metering.js'
import type { WorkerConfig } from './runner.js'

const DEFAULT_IDLE_TIMEOUT_SECONDS = 900

export const idleShutdownWorker: WorkerConfig<SandboxRepo | NodeClient | BillingService> = {
  name: 'idle-shutdown',
  intervalMs: 60_000,
  handler: Effect.gen(function* () {
    const repo = yield* SandboxRepo
    const nodeClient = yield* NodeClient
    const cutoff = new Date(Date.now() - DEFAULT_IDLE_TIMEOUT_SECONDS * 1000)
    const idle = yield* repo.findIdleSince(cutoff)
    const now = new Date()

    for (const sandbox of idle) {
      // Final meter before termination
      yield* meterSandbox(sandbox, now).pipe(Effect.catchAll(() => Effect.void))

      yield* nodeClient.stopSandbox({ sandboxId: sandbox.id }).pipe(
        Effect.catchAll(() => Effect.void),
      )
      yield* repo.updateStatus(sandbox.id, sandbox.orgId, 'stopped', {
        endedAt: now,
        failureReason: 'idle_timeout',
      })
    }

    return idle.length
  }),
}
