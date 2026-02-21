import { Effect, Layer } from 'effect'
import { QuotaService, DEFAULT_QUOTA, type QuotaApi, type OrgQuota } from './quota.js'

/** In-memory QuotaService for testing. Supports per-org overrides. */
export function createInMemoryQuotaApi(): QuotaApi & {
  /** Set custom quotas for an org (test helper). */
  setOrgQuota: (orgId: string, quota: Partial<OrgQuota>) => void
} {
  const overrides = new Map<string, OrgQuota>()

  return {
    getOrgQuota: (orgId) =>
      Effect.succeed(overrides.get(orgId) ?? DEFAULT_QUOTA),

    setOrgQuota: (orgId, quota) => {
      overrides.set(orgId, { ...DEFAULT_QUOTA, ...quota })
    },
  }
}

export const QuotaMemory = Layer.sync(QuotaService, () => createInMemoryQuotaApi())
