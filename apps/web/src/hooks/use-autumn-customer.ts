'use client'

import { useCustomer } from 'autumn-js/react'

export type FeatureUsage = {
  featureId: string
  name: string
  usage: number | undefined
  balance: number | null | undefined
  includedUsage: number | undefined
  unlimited: boolean
}

export type CreditBalance = {
  /** Credits remaining (balance from Autumn). */
  remaining: number
  /** Credits included in the plan (0 for top-up-only users). */
  included: number
  /** Credits consumed this period. */
  used: number
  /** Total credits available (included + top-ups). Used as denominator for progress bar. */
  total: number
}

export function useAutumnCustomer() {
  const result = useCustomer()
  const { customer } = result

  const activePlan =
    customer?.products.find((p) => p.status === 'active' && !p.is_add_on) ??
    null

  const planName = activePlan?.name ?? 'No Plan'

  const featureUsage: FeatureUsage[] = customer
    ? Object.entries(customer.features).map(([id, feature]) => ({
        featureId: id,
        name: feature.name,
        usage: feature.usage,
        balance: feature.balance,
        includedUsage: feature.included_usage,
        unlimited: feature.unlimited === true,
      }))
    : []

  // Extract credit balance from the 'credits' feature
  const creditsFeature = customer?.features['credits']
  const creditBalance: CreditBalance | null = creditsFeature
    ? (() => {
        const remaining = creditsFeature.balance ?? 0
        const included = creditsFeature.included_usage ?? 0
        const used = creditsFeature.usage ?? 0
        // Total = remaining + used (accounts for top-ups beyond included credits)
        const total = remaining + used
        return { remaining, included, used, total }
      })()
    : null

  return {
    ...result,
    activePlan,
    planName,
    featureUsage,
    creditBalance,
  }
}
