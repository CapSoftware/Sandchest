import type { Scope } from 'effect'
import type { RedisService } from '../services/redis.js'
import type { SandboxRepo } from '../services/sandbox-repo.js'
import type { ArtifactRepo } from '../services/artifact-repo.js'
import type { ObjectStorage } from '../services/object-storage.js'
import type { IdempotencyRepo } from './idempotency-cleanup.js'
import { startWorkers, type WorkerConfig } from './runner.js'
import { ttlEnforcementWorker } from './ttl-enforcement.js'
import { idleShutdownWorker } from './idle-shutdown.js'
import { orphanReconciliationWorker } from './orphan-reconciliation.js'
import { queueTimeoutWorker } from './queue-timeout.js'
import { idempotencyCleanupWorker } from './idempotency-cleanup.js'
import { artifactRetentionWorker } from './artifact-retention.js'
import { orgHardDeleteWorker } from './org-hard-delete.js'

export type WorkerDeps =
  | RedisService
  | SandboxRepo
  | ArtifactRepo
  | ObjectStorage
  | IdempotencyRepo

const allWorkers: ReadonlyArray<WorkerConfig<WorkerDeps>> = [
  ttlEnforcementWorker,
  idleShutdownWorker,
  orphanReconciliationWorker,
  queueTimeoutWorker,
  idempotencyCleanupWorker,
  artifactRetentionWorker,
  orgHardDeleteWorker,
]

export function startAllWorkers() {
  return startWorkers<WorkerDeps | RedisService | Scope.Scope>(allWorkers)
}

export { startWorkers, runWorkerTick, type WorkerConfig } from './runner.js'
