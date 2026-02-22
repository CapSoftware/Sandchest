import { Effect, Layer } from 'effect'
import { OrgRepo, type OrgRepoApi, type OrgRow } from './org-repo.js'

export function createInMemoryOrgRepo(): OrgRepoApi & {
  /** Seed a soft-deleted org (test helper). */
  addDeletedOrg: (orgId: string, deletedAt: Date) => void
} {
  const deletedOrgs = new Map<string, OrgRow>()
  const quotas = new Set<string>()
  const usageRows = new Map<string, number>()

  return {
    findSoftDeletedBefore: (cutoff) =>
      Effect.sync(() =>
        Array.from(deletedOrgs.values()).filter(
          (o) => o.deletedAt.getTime() < cutoff.getTime(),
        ),
      ),

    deleteQuota: (orgId) =>
      Effect.sync(() => (quotas.delete(orgId) ? 1 : 0)),

    deleteUsage: (orgId) =>
      Effect.sync(() => {
        const count = usageRows.get(orgId) ?? 0
        usageRows.delete(orgId)
        return count
      }),

    deleteOrg: (orgId) =>
      Effect.sync(() => {
        deletedOrgs.delete(orgId)
      }),

    addDeletedOrg: (orgId, deletedAt) => {
      deletedOrgs.set(orgId, { id: orgId, deletedAt })
      quotas.add(orgId)
      usageRows.set(orgId, 1)
    },
  }
}

export const OrgRepoMemory = Layer.sync(OrgRepo, () => createInMemoryOrgRepo())
