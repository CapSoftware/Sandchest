import { Effect } from 'effect'
import { ArtifactRepo } from '../services/artifact-repo.js'
import { ExecRepo } from '../services/exec-repo.js'
import { ObjectStorage } from '../services/object-storage.js'
import { OrgRepo } from '../services/org-repo.js'
import { SandboxRepo } from '../services/sandbox-repo.js'
import { SessionRepo } from '../services/session-repo.js'
import { IdempotencyRepo } from './idempotency-cleanup.js'
import type { WorkerConfig } from './runner.js'

const RETENTION_DAYS = 30

export type OrgHardDeleteDeps =
  | OrgRepo
  | ArtifactRepo
  | ExecRepo
  | SessionRepo
  | SandboxRepo
  | ObjectStorage
  | IdempotencyRepo

/**
 * Org hard-delete worker. Deletes all data for orgs that were soft-deleted
 * more than 30 days ago.
 *
 * Cascade order:
 *   1. Artifacts (S3 objects first, then DB rows)
 *   2. Execs
 *   3. Sessions
 *   4. Sandboxes
 *   5. Idempotency keys
 *   6. Org quotas
 *   7. Org usage
 *   8. Org record
 */
export const orgHardDeleteWorker: WorkerConfig<OrgHardDeleteDeps> = {
  name: 'org-hard-delete',
  intervalMs: 60 * 60_000,
  handler: Effect.gen(function* () {
    const orgRepo = yield* OrgRepo
    const artifactRepo = yield* ArtifactRepo
    const execRepo = yield* ExecRepo
    const sessionRepo = yield* SessionRepo
    const sandboxRepo = yield* SandboxRepo
    const objectStorage = yield* ObjectStorage
    const idempotencyRepo = yield* IdempotencyRepo

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    const orgs = yield* orgRepo.findSoftDeletedBefore(cutoff)
    if (orgs.length === 0) return 0

    for (const org of orgs) {
      // 1. Delete artifact S3 objects, then DB rows
      const artifacts = yield* artifactRepo.findByOrgId(org.id)
      for (const artifact of artifacts) {
        yield* objectStorage.deleteObject(artifact.ref).pipe(
          Effect.catchAll(() => Effect.void),
        )
      }
      yield* artifactRepo.deleteByOrgId(org.id)

      // 2. Delete execs
      yield* execRepo.deleteByOrgId(org.id)

      // 3. Delete sessions
      yield* sessionRepo.deleteByOrgId(org.id)

      // 4. Delete sandboxes
      yield* sandboxRepo.deleteByOrgId(org.id)

      // 5. Delete idempotency keys
      yield* idempotencyRepo.deleteByOrgId(org.id)

      // 6-7. Delete org quotas and usage
      yield* orgRepo.deleteQuota(org.id)
      yield* orgRepo.deleteUsage(org.id)

      // 8. Delete the org record itself
      yield* orgRepo.deleteOrg(org.id)
    }

    return orgs.length
  }),
}
