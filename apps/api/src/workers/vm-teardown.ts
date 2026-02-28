import { Effect } from 'effect'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { NodeClient } from '../services/node-client.js'
import type { WorkerConfig } from './runner.js'

/** Grace period before a 'stopping' sandbox is forcibly destroyed (30 seconds). */
const STOPPING_GRACE_SECONDS = 30

/**
 * Finds sandboxes stuck in 'stopping' state beyond the grace period
 * and forcibly destroys them on the node daemon.
 */
export const vmTeardownWorker: WorkerConfig<SandboxRepo | NodeClient> = {
  name: 'vm-teardown',
  intervalMs: 15_000,
  handler: Effect.gen(function* () {
    const repo = yield* SandboxRepo
    const nodeClient = yield* NodeClient
    const cutoff = new Date(Date.now() - STOPPING_GRACE_SECONDS * 1000)
    const stuck = yield* repo.findStoppingBefore(cutoff)

    for (const sandbox of stuck) {
      yield* nodeClient.destroySandbox({ sandboxId: sandbox.id }).pipe(
        Effect.catchAll(() => Effect.void),
      )
      yield* repo.updateStatus(sandbox.id, sandbox.orgId, 'stopped', {
        endedAt: new Date(),
      })
    }

    return stuck.length
  }),
}
