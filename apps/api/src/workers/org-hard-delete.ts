import { Effect } from 'effect'
import type { ArtifactRepo } from '../services/artifact-repo.js'
import type { ObjectStorage } from '../services/object-storage.js'
import type { WorkerConfig } from './runner.js'

/**
 * Org hard-delete worker. Deletes all data for orgs that were soft-deleted
 * more than 30 days ago.
 *
 * Note: This worker requires a soft-deleted orgs query (e.g. from BetterAuth
 * org table with a `deleted_at` column). Currently returns 0 since the org
 * soft-delete infrastructure is not yet wired up. The worker skeleton is in
 * place and ready to be connected once org lifecycle management is added.
 */
export const orgHardDeleteWorker: WorkerConfig<ArtifactRepo | ObjectStorage> = {
  name: 'org-hard-delete',
  intervalMs: 60 * 60_000,
  handler: Effect.succeed(0),
}
