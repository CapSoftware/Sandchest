import { Effect, Layer } from 'effect'
import { IdempotencyRepo, type IdempotencyRepoApi } from './idempotency-cleanup.js'

export function createInMemoryIdempotencyRepo(): IdempotencyRepoApi {
  const store = new Map<string, { createdAt: Date }>()

  return {
    deleteOlderThan: (cutoff) =>
      Effect.sync(() => {
        let deleted = 0
        for (const [key, entry] of store) {
          if (entry.createdAt.getTime() < cutoff.getTime()) {
            store.delete(key)
            deleted++
          }
        }
        return deleted
      }),
  }
}

/** Expose the internal store for test seeding. */
export function createTestableIdempotencyRepo() {
  const store = new Map<string, { createdAt: Date }>()

  const api: IdempotencyRepoApi = {
    deleteOlderThan: (cutoff) =>
      Effect.sync(() => {
        let deleted = 0
        for (const [key, entry] of store) {
          if (entry.createdAt.getTime() < cutoff.getTime()) {
            store.delete(key)
            deleted++
          }
        }
        return deleted
      }),
  }

  return { api, store }
}

export const IdempotencyRepoMemory = Layer.sync(IdempotencyRepo, createInMemoryIdempotencyRepo)
