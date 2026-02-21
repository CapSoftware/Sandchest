import { Effect, Layer } from 'effect'
import { base62Encode, bytesToId, idToBytes, ARTIFACT_PREFIX } from '@sandchest/contract'
import { ArtifactRepo, type ArtifactRow, type ArtifactRepoApi } from './artifact-repo.js'

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function createInMemoryArtifactRepo(): ArtifactRepoApi {
  const store = new Map<string, ArtifactRow>()

  function keyFor(id: Uint8Array): string {
    return base62Encode(id)
  }

  return {
    create: (params) =>
      Effect.sync(() => {
        const now = new Date()
        const row: ArtifactRow = {
          id: params.id,
          sandboxId: params.sandboxId,
          orgId: params.orgId,
          execId: params.execId ?? null,
          name: params.name,
          mime: params.mime,
          bytes: params.bytes,
          sha256: params.sha256,
          ref: params.ref,
          createdAt: now,
          retentionUntil: params.retentionUntil ?? null,
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

    list: (sandboxId, orgId, params) =>
      Effect.sync(() => {
        const limit = Math.min(params.limit ?? 50, 200)
        const rows = Array.from(store.values())
          .filter(
            (r) => bytesEqual(r.sandboxId, sandboxId) && r.orgId === orgId,
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

        let startIdx = 0
        if (params.cursor) {
          const cursorBytes = idToBytes(params.cursor)
          const cursorKey = keyFor(cursorBytes)
          const idx = rows.findIndex((r) => keyFor(r.id) === cursorKey)
          if (idx >= 0) startIdx = idx + 1
        }

        const page = rows.slice(startIdx, startIdx + limit)
        const hasMore = startIdx + limit < rows.length
        const nextCursor = hasMore
          ? bytesToId(ARTIFACT_PREFIX, page[page.length - 1].id)
          : null

        return { rows: page, nextCursor }
      }),

    count: (sandboxId, orgId) =>
      Effect.sync(() => {
        let n = 0
        for (const row of store.values()) {
          if (bytesEqual(row.sandboxId, sandboxId) && row.orgId === orgId) {
            n++
          }
        }
        return n
      }),

    findExpiredRetention: (before) =>
      Effect.sync(() =>
        Array.from(store.values()).filter(
          (r) => r.retentionUntil !== null && r.retentionUntil.getTime() < before.getTime(),
        ),
      ),

    deleteByIds: (ids) =>
      Effect.sync(() => {
        let deleted = 0
        for (const id of ids) {
          const key = keyFor(id)
          if (store.delete(key)) deleted++
        }
        return deleted
      }),
  }
}

export const ArtifactRepoMemory = Layer.sync(ArtifactRepo, createInMemoryArtifactRepo)
