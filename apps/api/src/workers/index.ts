import type { Scope } from 'effect'
import type { RedisService } from '../services/redis.js'
import type { SandboxRepo } from '../services/sandbox-repo.js'
import type { ArtifactRepo } from '../services/artifact-repo.js'
import type { ExecRepo } from '../services/exec-repo.js'
import type { SessionRepo } from '../services/session-repo.js'
import type { ObjectStorage } from '../services/object-storage.js'
import type { QuotaService } from '../services/quota.js'
import type { EventRecorder } from '../services/event-recorder.js'
import type { OrgRepo } from '../services/org-repo.js'
import type { IdempotencyRepo } from './idempotency-cleanup.js'
import type { MetricsRepo } from '../services/metrics-repo.js'
import { startWorkers, type WorkerConfig } from './runner.js'
import { ttlEnforcementWorker } from './ttl-enforcement.js'
import { ttlWarningWorker } from './ttl-warning.js'
import { idleShutdownWorker } from './idle-shutdown.js'
import { orphanReconciliationWorker } from './orphan-reconciliation.js'
import { queueTimeoutWorker } from './queue-timeout.js'
import { idempotencyCleanupWorker } from './idempotency-cleanup.js'
import { artifactRetentionWorker } from './artifact-retention.js'
import { orgHardDeleteWorker } from './org-hard-delete.js'
import { replayRetentionWorker } from './replay-retention.js'
import { metricsRetentionWorker } from './metrics-retention.js'

export type WorkerDeps =
  | RedisService
  | SandboxRepo
  | ArtifactRepo
  | ExecRepo
  | SessionRepo
  | ObjectStorage
  | QuotaService
  | EventRecorder
  | OrgRepo
  | IdempotencyRepo
  | MetricsRepo

const allWorkers: ReadonlyArray<WorkerConfig<WorkerDeps>> = [
  ttlEnforcementWorker,
  ttlWarningWorker,
  idleShutdownWorker,
  orphanReconciliationWorker,
  queueTimeoutWorker,
  idempotencyCleanupWorker,
  artifactRetentionWorker,
  orgHardDeleteWorker,
  replayRetentionWorker,
  metricsRetentionWorker,
]

export function startAllWorkers() {
  return startWorkers<WorkerDeps | RedisService | Scope.Scope>(allWorkers)
}

export { startWorkers, runWorkerTick, type WorkerConfig } from './runner.js'
