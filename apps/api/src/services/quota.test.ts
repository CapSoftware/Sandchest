import { Effect } from 'effect'
import { describe, expect, test, beforeEach } from 'bun:test'
import { createInMemoryQuotaApi } from './quota.memory.js'
import { DEFAULT_QUOTA, type QuotaApi } from './quota.js'

type TestQuotaApi = QuotaApi & { setOrgQuota: (orgId: string, quota: Partial<typeof DEFAULT_QUOTA>) => void }

let api: TestQuotaApi

function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
  return Effect.runPromise(effect)
}

const ORG_A = 'org_alpha'
const ORG_B = 'org_beta'

beforeEach(() => {
  api = createInMemoryQuotaApi()
})

describe('getOrgQuota', () => {
  test('returns defaults when no override set', async () => {
    const quota = await run(api.getOrgQuota(ORG_A))
    expect(quota).toEqual(DEFAULT_QUOTA)
  })

  test('returns per-org overrides', async () => {
    api.setOrgQuota(ORG_A, { maxConcurrentSandboxes: 50, maxTtlSeconds: 7200 })
    const quota = await run(api.getOrgQuota(ORG_A))
    expect(quota.maxConcurrentSandboxes).toBe(50)
    expect(quota.maxTtlSeconds).toBe(7200)
    // Non-overridden fields stay at defaults
    expect(quota.maxExecTimeoutSeconds).toBe(DEFAULT_QUOTA.maxExecTimeoutSeconds)
    expect(quota.rateExecPerMin).toBe(DEFAULT_QUOTA.rateExecPerMin)
  })

  test('different orgs have independent quotas', async () => {
    api.setOrgQuota(ORG_A, { maxConcurrentSandboxes: 100 })
    const quotaA = await run(api.getOrgQuota(ORG_A))
    const quotaB = await run(api.getOrgQuota(ORG_B))
    expect(quotaA.maxConcurrentSandboxes).toBe(100)
    expect(quotaB.maxConcurrentSandboxes).toBe(DEFAULT_QUOTA.maxConcurrentSandboxes)
  })

  test('overrides all rate limit fields', async () => {
    api.setOrgQuota(ORG_A, {
      rateSandboxCreatePerMin: 5,
      rateExecPerMin: 10,
      rateReadPerMin: 20,
    })
    const quota = await run(api.getOrgQuota(ORG_A))
    expect(quota.rateSandboxCreatePerMin).toBe(5)
    expect(quota.rateExecPerMin).toBe(10)
    expect(quota.rateReadPerMin).toBe(20)
  })

  test('overrides fork limits', async () => {
    api.setOrgQuota(ORG_A, { maxForkDepth: 2, maxForksPerSandbox: 3 })
    const quota = await run(api.getOrgQuota(ORG_A))
    expect(quota.maxForkDepth).toBe(2)
    expect(quota.maxForksPerSandbox).toBe(3)
  })
})
