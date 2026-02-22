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
        Effect.catchAll(() => Effect.void),
        Effect.map(() => undefined),
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
    } satisfies BillingApi
  }
  return createAutumnBillingApi(secretKey)
})
