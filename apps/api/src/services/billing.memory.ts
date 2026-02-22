import { Effect, Layer } from 'effect'
import { BillingService, type BillingApi, type BillingCheckResult } from './billing.js'

export interface TrackedEvent {
  readonly customerId: string
  readonly featureId: string
  readonly value: number
}

/** In-memory BillingService for testing. All checks pass by default. */
export function createInMemoryBillingApi(): BillingApi & {
  /** Tracked events for test assertions. */
  readonly _tracked: TrackedEvent[]
  /** Set a feature as blocked for a specific customer. */
  readonly blockFeature: (customerId: string, featureId: string) => void
  /** Clear a previously blocked feature. */
  readonly unblockFeature: (customerId: string, featureId: string) => void
} {
  const blocked = new Set<string>()
  const tracked: TrackedEvent[] = []

  function key(customerId: string, featureId: string): string {
    return `${customerId}:${featureId}`
  }

  return {
    _tracked: tracked,

    blockFeature: (customerId, featureId) => {
      blocked.add(key(customerId, featureId))
    },

    unblockFeature: (customerId, featureId) => {
      blocked.delete(key(customerId, featureId))
    },

    check: (customerId, featureId) =>
      Effect.succeed({
        allowed: !blocked.has(key(customerId, featureId)),
        featureId,
        balance: null,
        unlimited: undefined,
      } satisfies BillingCheckResult),

    track: (customerId, featureId, value) =>
      Effect.sync(() => {
        tracked.push({ customerId, featureId, value: value ?? 1 })
      }),
  }
}

export const BillingMemory = Layer.sync(BillingService, () => createInMemoryBillingApi())
