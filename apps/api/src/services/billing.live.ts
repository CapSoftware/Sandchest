import { Effect, Layer } from 'effect'
import { Autumn } from 'autumn-js'
import { BillingService, type BillingApi } from './billing.js'
import { loadEnv } from '../env.js'

export function createAutumnBillingApi(secretKey: string): BillingApi {
  const autumn = new Autumn({ secretKey })

  return {
    check: (customerId, featureId) =>
      Effect.tryPromise(() =>
        autumn.check({ customer_id: customerId, feature_id: featureId }),
      ).pipe(
        Effect.map((result) => ({
          allowed: result.data?.allowed ?? true,
          featureId,
          balance: result.data?.balance,
          unlimited: result.data?.unlimited,
        })),
        Effect.tapError((err) =>
          Effect.logWarning(`Billing check failed for ${customerId}/${featureId}: ${err}`),
        ),
        Effect.catchAll(() =>
          Effect.succeed({
            allowed: true,
            featureId,
            balance: null,
            unlimited: undefined,
          }),
        ),
      ),

    track: (customerId, featureId, value) =>
      Effect.tryPromise(() =>
        autumn.track({
          customer_id: customerId,
          feature_id: featureId,
          value: value ?? 1,
        }),
      ).pipe(
        Effect.tapError((err) =>
          Effect.logWarning(`Billing track failed for ${customerId}/${featureId}: ${err}`),
        ),
        Effect.catchAll(() => Effect.void),
        Effect.map(() => undefined),
      ),

    trackCompute: (customerId, dollarAmount, sandboxId) =>
      Effect.tryPromise(() =>
        autumn.track({
          customer_id: customerId,
          feature_id: 'compute',
          value: dollarAmount,
          properties: { sandbox_id: sandboxId },
        }),
      ).pipe(
        Effect.tapError((err) =>
          Effect.logWarning(`Billing trackCompute failed for ${customerId}/${sandboxId}: ${err}`),
        ),
        Effect.catchAll(() => Effect.void),
        Effect.map(() => undefined),
      ),

    checkCredits: (customerId, estimatedDollars) =>
      Effect.tryPromise(() =>
        autumn.check({
          customer_id: customerId,
          feature_id: 'credits',
          // Always send a required_balance so Autumn checks actual balance.
          // Use the estimate if provided, otherwise check for at least $0.01.
          required_balance: estimatedDollars > 0 ? estimatedDollars : 0.01,
        }),
      ).pipe(
        Effect.map((result) => ({
          allowed: result.data?.allowed ?? true,
          featureId: 'credits',
          balance: result.data?.balance,
          unlimited: result.data?.unlimited,
        })),
        Effect.tapError((err) =>
          Effect.logWarning(`Failed to check credits for ${customerId}: ${err}`),
        ),
        Effect.catchAll(() =>
          Effect.succeed({
            allowed: true,
            featureId: 'credits',
            balance: null,
            unlimited: undefined,
          }),
        ),
      ),
    getBillingTier: (customerId) =>
      Effect.tryPromise(async () => {
        const customer = await autumn.customers.get(customerId)
        const products = customer?.data?.products ?? []
        const hasMax = products.some(
          (p: { id?: string; status?: string }) =>
            p.id === 'max' && p.status === 'active',
        )
        return hasMax ? 'max' as const : 'free' as const
      }).pipe(
        Effect.tapError((err) =>
          Effect.logWarning(`Failed to get billing tier for ${customerId}: ${err}`),
        ),
        Effect.catchAll(() => Effect.succeed('free' as const)),
      ),
  }
}

export const BillingLive = Layer.sync(BillingService, () => {
  const secretKey = loadEnv().AUTUMN_SECRET_KEY
  if (!secretKey) {
    // Return a no-op implementation when Autumn is not configured
    return {
      check: (_customerId, featureId) =>
        Effect.succeed({
          allowed: true,
          featureId,
          balance: null,
          unlimited: undefined,
        }),
      track: () => Effect.void,
      trackCompute: () => Effect.void,
      checkCredits: (_customerId, _estimatedDollars) =>
        Effect.succeed({
          allowed: true,
          featureId: 'credits',
          balance: null,
          unlimited: undefined,
        }),
      getBillingTier: () => Effect.succeed('free' as const),
    } satisfies BillingApi
  }
  return createAutumnBillingApi(secretKey)
})
