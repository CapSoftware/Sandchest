import { Context, type Effect } from 'effect'

/** Org-level quota settings resolved from the org_quotas table. */
export interface OrgQuota {
  readonly maxConcurrentSandboxes: number
  readonly maxTtlSeconds: number
  readonly maxExecTimeoutSeconds: number
  readonly artifactRetentionDays: number
  readonly rateSandboxCreatePerMin: number
  readonly rateExecPerMin: number
  readonly rateReadPerMin: number
  readonly idleTimeoutSeconds: number
  readonly maxForkDepth: number
  readonly maxForksPerSandbox: number
  readonly replayRetentionDays: number
}

/** Default quotas matching the DB column defaults in org_quotas. */
export const DEFAULT_QUOTA: OrgQuota = {
  maxConcurrentSandboxes: 10,
  maxTtlSeconds: 14400,
  maxExecTimeoutSeconds: 7200,
  artifactRetentionDays: 30,
  rateSandboxCreatePerMin: 30,
  rateExecPerMin: 120,
  rateReadPerMin: 600,
  idleTimeoutSeconds: 900,
  maxForkDepth: 5,
  maxForksPerSandbox: 10,
  replayRetentionDays: 30,
}

export interface QuotaApi {
  /** Resolve quotas for an org. Returns defaults if no row exists. */
  readonly getOrgQuota: (orgId: string) => Effect.Effect<OrgQuota, never, never>
}

export class QuotaService extends Context.Tag('QuotaService')<QuotaService, QuotaApi>() {}
