import { Effect, Layer } from 'effect'
import { NodeRepo, type NodeRow, type NodeRepoApi } from './node-repo.js'

function keyOf(id: Uint8Array): string {
  return Array.from(id).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function createInMemoryNodeRepo(): NodeRepoApi {
  const store = new Map<string, NodeRow>()

  return {
    list: () => Effect.succeed(Array.from(store.values())),

    findById: (id) => Effect.succeed(store.get(keyOf(id)) ?? null),

    create: (params) =>
      Effect.sync(() => {
        const now = new Date()
        const row: NodeRow = {
          id: params.id,
          name: params.name,
          hostname: params.hostname,
          slotsTotal: params.slotsTotal,
          status: params.status,
          version: params.version,
          firecrackerVersion: params.firecrackerVersion,
          capabilities: null,
          lastSeenAt: null,
          createdAt: now,
          updatedAt: now,
        }
        store.set(keyOf(params.id), row)
      }),

    update: (id, fields) =>
      Effect.sync(() => {
        const key = keyOf(id)
        const existing = store.get(key)
        if (!existing) return
        store.set(key, {
          ...existing,
          ...(fields.status !== undefined ? { status: fields.status } : {}),
          ...(fields.slotsTotal !== undefined ? { slotsTotal: fields.slotsTotal } : {}),
          ...(fields.version !== undefined ? { version: fields.version } : {}),
          ...(fields.firecrackerVersion !== undefined ? { firecrackerVersion: fields.firecrackerVersion } : {}),
          updatedAt: new Date(),
        })
      }),

    remove: (id) =>
      Effect.sync(() => {
        store.delete(keyOf(id))
      }),

    countActiveSandboxes: () => Effect.succeed(0),

    touchLastSeen: (id) =>
      Effect.sync(() => {
        const key = keyOf(id)
        const existing = store.get(key)
        if (!existing) return
        const now = new Date()
        store.set(key, { ...existing, lastSeenAt: now, updatedAt: now })
      }),
  }
}

export const NodeRepoMemory = Layer.sync(NodeRepo, createInMemoryNodeRepo)
