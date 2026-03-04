import { Context, type Effect } from 'effect'

/** Result of an Autumn feature access check. */
export interface BillingCheckResult {
  readonly allowed: boolean
  readonly featureId: string
  readonly balance: number | null | undefined
  readonly unlimited: boolean | undefined
}

export interface BillingApi {
  /** Check whether a customer has access to a feature. */
  readonly check: (
    customerId: string,
    featureId: string,
  ) => Effect.Effect<BillingCheckResult, never, never>

  /** Track usage of a metered feature (fire-and-forget, never fails). */
  readonly track: (
    customerId: string,
    featureId: string,
    value?: number | undefined,
  ) => Effect.Effect<void, never, never>

  /** Track compute usage in dollar amount (deducts from credit balance). */
  readonly trackCompute: (
    customerId: string,
    dollarAmount: number,
    sandboxId: string,
  ) => Effect.Effect<void, never, never>

  /** Check whether a customer has sufficient credits for an estimated cost. */
  readonly checkCredits: (
    customerId: string,
    estimatedDollars: number,
  ) => Effect.Effect<BillingCheckResult, never, never>

  /** Get the billing tier for a customer ('free' or 'max'). */
  readonly getBillingTier: (
    customerId: string,
  ) => Effect.Effect<'free' | 'max', never, never>
}

export class BillingService extends Context.Tag('BillingService')<BillingService, BillingApi>() {}
