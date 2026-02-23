'use client'

import { useCustomer } from 'autumn-js/react'

type BillingCheckResult = {
  allowed: boolean
  balance: number | null | undefined
  usage: number | undefined
  unlimited: boolean
}

export function useBillingCheck(featureId: string): BillingCheckResult {
  const { customer, check } = useCustomer()

  if (!customer) {
    return { allowed: false, balance: undefined, usage: undefined, unlimited: false }
  }

  const feature = customer.features[featureId]

  if (!feature) {
    return { allowed: false, balance: undefined, usage: undefined, unlimited: false }
  }

  if (feature.unlimited === true) {
    return { allowed: true, balance: feature.balance, usage: feature.usage, unlimited: true }
  }

  const { data } = check({ featureId })
  const allowed = data?.allowed ?? false

  return {
    allowed,
    balance: feature.balance,
    usage: feature.usage,
    unlimited: false,
  }
}
