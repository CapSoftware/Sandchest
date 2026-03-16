import { Effect } from 'effect'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { NodeClientRegistry } from '../services/node-client-registry.js'
import { bytesToHex } from '../services/node-client.shared.js'
import { RedisService } from '../services/redis.js'
import { releaseSlot } from '../services/scheduler.js'
import type { BillingService } from '../services/billing.js'
import { meterSandbox } from './credit-metering.js'
import type { WorkerConfig } from './runner.js'

const DEFAULT_IDLE_TIMEOUT_SECONDS = 900

export const idleShutdownWorker: WorkerConfig<SandboxRepo | NodeClientRegistry | BillingService | RedisService> = {
  name: 'idle-shutdown',
  intervalMs: 60_000,
  handler: Effect.gen(function* () {
    const repo = yield* SandboxRepo
    const registry = yield* NodeClientRegistry
    const cutoff = new Date(Date.now() - DEFAULT_IDLE_TIMEOUT_SECONDS * 1000)
    const idle = yield* repo.findIdleSince(cutoff)
    const now = new Date()
    let processed = 0

    for (const sandbox of idle) {
      // Final meter before termination
      yield* meterSandbox(sandbox, now).pipe(Effect.catchAll(() => Effect.void))

      if (!sandbox.nodeId) continue
      const nodeIdHex = bytesToHex(sandbox.nodeId)
      const nodeClient = yield* registry.getClient(nodeIdHex).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )
      if (!nodeClient) continue

      yield* nodeClient.stopSandbox({ sandboxId: sandbox.id }).pipe(
        Effect.catchAll(() => Effect.void),
      )
      yield* repo.updateStatus(sandbox.id, sandbox.orgId, 'stopped', {
        endedAt: now,
        failureReason: 'idle_timeout',
      })

      if (sandbox.slotIndex !== null) {
        yield* releaseSlot(nodeIdHex, sandbox.slotIndex).pipe(
          Effect.catchAll(() => Effect.void),
        )
      }
      processed += 1
    }

    return processed
  }),
}
