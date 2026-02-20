import { Effect, Layer } from 'effect'
import { base62Encode } from '@sandchest/contract'
import { SessionRepo, type SessionRow, type SessionRepoApi } from './session-repo.js'

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function createInMemorySessionRepo(): SessionRepoApi {
  const store = new Map<string, SessionRow>()

  function keyFor(id: Uint8Array): string {
    return base62Encode(id)
  }

  return {
    create: (params) =>
      Effect.sync(() => {
        const now = new Date()
        const row: SessionRow = {
          id: params.id,
          sandboxId: params.sandboxId,
          orgId: params.orgId,
          shell: params.shell,
          status: 'running',
          createdAt: now,
          updatedAt: now,
          destroyedAt: null,
        }
        store.set(keyFor(params.id), row)
        return row
      }),

    findById: (id, sandboxId, orgId) =>
      Effect.sync(() => {
        const row = store.get(keyFor(id))
        if (!row) return null
        if (!bytesEqual(row.sandboxId, sandboxId)) return null
        if (row.orgId !== orgId) return null
        return row
      }),

    list: (sandboxId, orgId) =>
      Effect.sync(() => {
        return Array.from(store.values()).filter(
          (r) => bytesEqual(r.sandboxId, sandboxId) && r.orgId === orgId,
        )
      }),

    countActive: (sandboxId) =>
      Effect.sync(() => {
        return Array.from(store.values()).filter(
          (r) => bytesEqual(r.sandboxId, sandboxId) && r.status === 'running',
        ).length
      }),

    destroy: (id, sandboxId, orgId) =>
      Effect.sync(() => {
        const key = keyFor(id)
        const row = store.get(key)
        if (!row) return null
        if (!bytesEqual(row.sandboxId, sandboxId)) return null
        if (row.orgId !== orgId) return null
        const now = new Date()
        const updated: SessionRow = {
          ...row,
          status: 'destroyed',
          updatedAt: now,
          destroyedAt: now,
        }
        store.set(key, updated)
        return updated
      }),
  }
}

export const SessionRepoMemory = Layer.sync(SessionRepo, createInMemorySessionRepo)
