import { Effect, Layer } from 'effect'
import { eq } from 'drizzle-orm'
import type { Database } from '@sandchest/db/client'
import { orgQuotas } from '@sandchest/db/schema'
import { QuotaService, DEFAULT_QUOTA, type QuotaApi } from './quota.js'

export function createDrizzleQuotaApi(db: Database): QuotaApi {
  return {
    getOrgQuota: (orgId) =>
      Effect.promise(async () => {
        const [row] = await db
          .select()
          .from(orgQuotas)
          .where(eq(orgQuotas.orgId, orgId))
          .limit(1)

        if (!row) return DEFAULT_QUOTA

        return {
          maxConcurrentSandboxes: row.maxConcurrentSandboxes,
          maxTtlSeconds: row.maxTtlSeconds,
          maxExecTimeoutSeconds: row.maxExecTimeoutSeconds,
          artifactRetentionDays: row.artifactRetentionDays,
          rateSandboxCreatePerMin: row.rateSandboxCreatePerMin,
          rateExecPerMin: row.rateExecPerMin,
          rateReadPerMin: row.rateReadPerMin,
          idleTimeoutSeconds: row.idleTimeoutSeconds,
          maxForkDepth: row.maxForkDepth,
          maxForksPerSandbox: row.maxForksPerSandbox,
          replayRetentionDays: row.replayRetentionDays,
        }
      }),
  }
}

export const makeQuotaDrizzle = (db: Database) =>
  Layer.sync(QuotaService, () => createDrizzleQuotaApi(db))
