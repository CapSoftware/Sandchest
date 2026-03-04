'use client'

import { useCustomer } from 'autumn-js/react'

type BillingCheckResult = {
  allowed: boolean
  balance: number | null | undefined
  usage: number | undefined
  unlimited: boolean
}

/**
 * Check whether the user has credits available.
 * Always checks the 'credits' feature under the credit billing model.
 */
export function useBillingCheck(): BillingCheckResult {
  const { customer, check } = useCustomer()

  if (!customer) {
    return { allowed: false, balance: undefined, usage: undefined, unlimited: false }
  }

  const feature = customer.features['credits']

  if (!feature) {
    // No credits feature configured — fail closed to prevent billing bypass
    return { allowed: false, balance: undefined, usage: undefined, unlimited: false }
  }

  if (feature.unlimited === true) {
    return { allowed: true, balance: feature.balance, usage: feature.usage, unlimited: true }
  }

  const { data } = check({ featureId: 'credits' })
  const allowed = data?.allowed ?? false

  return {
    allowed,
    balance: feature.balance,
    usage: feature.usage,
    unlimited: false,
  }
}
