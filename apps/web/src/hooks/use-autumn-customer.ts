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

  return {
    ...result,
    activePlan,
    planName,
    featureUsage,
  }
}
