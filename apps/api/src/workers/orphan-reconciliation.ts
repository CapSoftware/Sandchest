import { Effect } from 'effect'
import { NodeRepo } from '../services/node-repo.js'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { RedisService } from '../services/redis.js'
import type { BillingService } from '../services/billing.js'
import { bytesToId, NODE_PREFIX } from '@sandchest/contract'
import { meterSandbox } from './credit-metering.js'
import type { WorkerConfig } from './runner.js'

export const orphanReconciliationWorker: WorkerConfig<SandboxRepo | RedisService | BillingService | NodeRepo> = {
  name: 'orphan-reconciliation',
  intervalMs: 60_000,
  handler: Effect.gen(function* () {
    const repo = yield* SandboxRepo
    const redis = yield* RedisService
    const nodeRepo = yield* NodeRepo

    const activeNodeIds = yield* repo.getActiveNodeIds()
    if (activeNodeIds.length === 0) return 0

    const offlineNodeIds: Uint8Array[] = []
    for (const nodeId of activeNodeIds) {
      const nodeIdStr = bytesToId(NODE_PREFIX, nodeId)
      const alive = yield* redis.hasNodeHeartbeat(nodeIdStr)
      if (!alive) {
        const node = yield* nodeRepo.findById(nodeId)
        if (!node?.lastSeenAt) {
          continue
        }
        offlineNodeIds.push(nodeId)
      }
    }

    if (offlineNodeIds.length === 0) return 0

    const orphans = yield* repo.findRunningOnNodes(offlineNodeIds)
    const now = new Date()

    for (const sandbox of orphans) {
      // Final meter before termination
      yield* meterSandbox(sandbox, now).pipe(Effect.catchAll(() => Effect.void))

      yield* repo.updateStatus(sandbox.id, sandbox.orgId, 'failed', {
        endedAt: now,
        failureReason: 'node_lost',
      })
    }

    return orphans.length
  }),
}
