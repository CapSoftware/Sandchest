import { Effect, Layer } from 'effect'
import { ObjectStorage, type ObjectStorageApi } from './object-storage.js'

/** In-memory object storage implementation for testing. */
export function createInMemoryObjectStorage(): ObjectStorageApi {
  const store = new Map<string, string>()

  return {
    putObject: (key, body) =>
      Effect.sync(() => {
        const content = typeof body === 'string' ? body : new TextDecoder().decode(body)
        store.set(key, content)
      }),

    getObject: (key) =>
      Effect.sync(() => store.get(key) ?? null),

    getPresignedUrl: (key, expiresInSeconds) =>
      Effect.sync(() =>
        `https://s3.example.com/${key}?expires=${expiresInSeconds}`,
      ),
  }
}

export const ObjectStorageMemory = Layer.sync(ObjectStorage, createInMemoryObjectStorage)
