import competitorsJson from './competitors.json'

export interface CompetitorPlan {
  name: string
  monthlyPrice: number
  storageFreeGiB: number
  maxSessionHours: number | null
  maxConcurrent: number | null
}

export interface Competitor {
  name: string
  rates: {
    vcpuPerSec: number
    vcpuPerHr: number
    ramGiBPerSec: number
    ramGiBPerHr: number
    storageGiBPerSec: number | null
    storageGiBPerHr: number | null
  }
  plans: CompetitorPlan[]
  freeCredits: {
    amount: number
    recurring: boolean
  }
  features: {
    sessionReplay: boolean
    subSecondForking: boolean
    mcpServer: boolean
    cliWithSsh: boolean
    vmIsolation: boolean
    typescriptSdk: boolean
  }
}

export const competitors: { e2b: Competitor; daytona: Competitor } = competitorsJson

export const SANDCHEST_TIERS = {
  free: {
    name: 'Free' as const,
    monthlyBase: 0,
    vcpuPerHr: 0.030,
    ramGiBPerHr: 0.010,
    vcpuPerSec: 0.0000083,
    ramGiBPerSec: 0.0000028,
    monthlyCredits: 100,
    maxConcurrent: 5,
    maxSessionHours: 1,
  },
  max: {
    name: 'Max' as const,
    monthlyBase: 49,
    vcpuPerHr: 0.025,
    ramGiBPerHr: 0.008,
    vcpuPerSec: 0.0000069,
    ramGiBPerSec: 0.0000022,
    monthlyCredits: 200,
    maxConcurrent: 25,
    maxSessionHours: 24,
  },
} as const

export type SandchestTierKey = keyof typeof SANDCHEST_TIERS

/** Per-hour compute cost for a given sandbox configuration */
export function sandboxPerHr(vcpuPerHr: number, ramGiBPerHr: number, vcpus = 2, ramGiB = 4) {
  return vcpus * vcpuPerHr + ramGiB * ramGiBPerHr
}

/** Hours in a 30-day month */
const HOURS_PER_MONTH = 720

/** Default storage assumption for cost scenarios (GiB) */
const DEFAULT_STORAGE_GIB = 20

/**
 * Monthly cost for a competitor given a specific plan.
 * Includes platform fee and storage costs for a fair comparison.
 */
export function competitorMonthlyCost(
  hours: number,
  c: Competitor,
  plan: CompetitorPlan,
  storageGiB = DEFAULT_STORAGE_GIB,
) {
  const compute = hours * sandboxPerHr(c.rates.vcpuPerHr, c.rates.ramGiBPerHr)
  const platformFee = plan.monthlyPrice
  const billableStorageGiB = Math.max(0, storageGiB - plan.storageFreeGiB)
  const storageCost =
    c.rates.storageGiBPerHr != null
      ? billableStorageGiB * c.rates.storageGiBPerHr * HOURS_PER_MONTH
      : 0
  return platformFee + compute + storageCost
}

/** Monthly cost for a Sandchest tier (standard small sandbox: 2 vCPU, 4 GiB) */
export function sandchestMonthlyCost(hours: number, tier: SandchestTierKey) {
  const t = SANDCHEST_TIERS[tier]
  const usage = hours * sandboxPerHr(t.vcpuPerHr, t.ramGiBPerHr)
  return t.monthlyBase + Math.max(0, usage - t.monthlyCredits)
}

/** Helper to get a competitor's free plan */
export function freePlan(c: Competitor): CompetitorPlan {
  return c.plans.find((p) => p.monthlyPrice === 0) ?? c.plans[0]
}

/** Helper to get a competitor's most expensive paid plan */
export function paidPlan(c: Competitor): CompetitorPlan | undefined {
  return c.plans.find((p) => p.monthlyPrice > 0)
}
