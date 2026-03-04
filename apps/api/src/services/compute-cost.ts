import type { ProfileName } from '@sandchest/contract'

/** Per-tier compute rates in $/hour per unit. */
const RATES = {
  free: { vcpuPerHr: 0.030, ramGiBPerHr: 0.010 },
  max: { vcpuPerHr: 0.025, ramGiBPerHr: 0.008 },
} as const

export type BillingTier = 'free' | 'max'

/** Profile resource specs for billing calculations. */
const PROFILE_RESOURCES: Record<ProfileName, { vcpus: number; ramGiB: number }> = {
  small: { vcpus: 2, ramGiB: 4 },
  medium: { vcpus: 4, ramGiB: 8 },
  large: { vcpus: 8, ramGiB: 16 },
}

/**
 * Calculate the dollar cost for a given number of minutes of compute.
 * Returns a value rounded to 6 decimal places.
 */
export function computeCostForMinutes(
  minutes: number,
  tier: BillingTier,
  vcpus = 2,
  ramGiB = 4,
): number {
  const rates = RATES[tier]
  const perHr = vcpus * rates.vcpuPerHr + ramGiB * rates.ramGiBPerHr
  return Math.round((minutes / 60) * perHr * 1_000_000) / 1_000_000
}

/**
 * Calculate the dollar cost for a sandbox profile over a given number of minutes.
 */
export function computeCostForProfile(
  minutes: number,
  tier: BillingTier,
  profileName: ProfileName,
): number {
  const resources = PROFILE_RESOURCES[profileName]
  return computeCostForMinutes(minutes, tier, resources.vcpus, resources.ramGiB)
}
