import { Effect } from 'effect'
import { ArtifactRepo } from '../services/artifact-repo.js'
import { ObjectStorage } from '../services/object-storage.js'
import type { WorkerConfig } from './runner.js'

export const artifactRetentionWorker: WorkerConfig<ArtifactRepo | ObjectStorage> = {
  name: 'artifact-retention',
  intervalMs: 60 * 60_000,
  handler: Effect.gen(function* () {
    const artifactRepo = yield* ArtifactRepo
    const storage = yield* ObjectStorage

    const now = new Date()
    const expired = yield* artifactRepo.findExpiredRetention(now)
    if (expired.length === 0) return 0

    for (const artifact of expired) {
      yield* storage.deleteObject(artifact.ref)
    }

    const deleted = yield* artifactRepo.deleteByIds(expired.map((a) => a.id))
    return deleted
  }),
}
