import { Effect } from 'effect'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { NodeClientRegistry } from '../services/node-client-registry.js'
import { bytesToHex } from '../services/node-client.shared.js'
import { RedisService } from '../services/redis.js'
import { releaseSlot } from '../services/scheduler.js'
import type { BillingService } from '../services/billing.js'
import { meterSandbox } from './credit-metering.js'
import type { WorkerConfig } from './runner.js'

/** Grace period before a 'stopping' sandbox is forcibly destroyed (30 seconds). */
const STOPPING_GRACE_SECONDS = 30

/**
 * Finds sandboxes stuck in 'stopping' state beyond the grace period
 * and forcibly destroys them on the node daemon.
 */
export const vmTeardownWorker: WorkerConfig<SandboxRepo | NodeClientRegistry | BillingService | RedisService> = {
  name: 'vm-teardown',
  intervalMs: 15_000,
  handler: Effect.gen(function* () {
    const repo = yield* SandboxRepo
    const registry = yield* NodeClientRegistry
    const cutoff = new Date(Date.now() - STOPPING_GRACE_SECONDS * 1000)
    const stuck = yield* repo.findStoppingBefore(cutoff)
    const now = new Date()
    let tornDown = 0

    for (const sandbox of stuck) {
      // Final meter before termination
      yield* meterSandbox(sandbox, now).pipe(Effect.catchAll(() => Effect.void))

      if (!sandbox.nodeId) continue
      const nodeIdHex = bytesToHex(sandbox.nodeId)
      const nodeClient = yield* registry.getClient(nodeIdHex).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )
      if (!nodeClient) continue

      const destroyed = yield* nodeClient.destroySandbox({ sandboxId: sandbox.id }).pipe(
        Effect.as(true),
        Effect.catchAllCause(() => Effect.succeed(false)),
      )
      if (!destroyed) {
        continue
      }

      // Release slot before status update so it's freed even if the update fails
      if (sandbox.slotIndex !== null) {
        yield* releaseSlot(nodeIdHex, sandbox.slotIndex).pipe(
          Effect.catchAll(() => Effect.void),
        )
      }

      yield* repo.updateStatus(sandbox.id, sandbox.orgId, 'stopped', {
        endedAt: now,
      })
      tornDown += 1
    }

    return tornDown
  }),
}
