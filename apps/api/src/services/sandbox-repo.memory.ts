import { Effect, Layer } from 'effect'
import {
  bytesToId,
  idToBytes,
  SANDBOX_PREFIX,
  base62Encode,
} from '@sandchest/contract'
import type { ProfileName, SandboxStatus, FailureReason } from '@sandchest/contract'
import { SandboxRepo, type SandboxRow, type SandboxRepoApi } from './sandbox-repo.js'

const SEED_IMAGE_ID = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0])
const SEED_PROFILE_IDS: Record<ProfileName, Uint8Array> = {
  small: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
  medium: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]),
  large: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3]),
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function createInMemorySandboxRepo(): SandboxRepoApi {
  const store = new Map<string, SandboxRow>()

  function keyFor(id: Uint8Array): string {
    return base62Encode(id)
  }

  return {
    resolveImage: (imageStr) =>
      Effect.succeed(
        imageStr === 'ubuntu-22.04' || imageStr === 'ubuntu-22.04/base'
          ? { id: SEED_IMAGE_ID, ref: `sandchest://${imageStr}` }
          : null,
      ),

    resolveProfile: (name) =>
      Effect.succeed(
        name in SEED_PROFILE_IDS ? { id: SEED_PROFILE_IDS[name] } : null,
      ),

    create: (params) =>
      Effect.sync(() => {
        const now = new Date()
        const row: SandboxRow = {
          id: params.id,
          orgId: params.orgId,
          imageId: params.imageId,
          profileId: params.profileId,
          profileName: params.profileName,
          status: 'queued',
          env: params.env,
          forkedFrom: null,
          forkDepth: 0,
          forkCount: 0,
          ttlSeconds: params.ttlSeconds,
          failureReason: null,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          endedAt: null,
          imageRef: params.imageRef,
        }
        store.set(keyFor(params.id), row)
        return row
      }),

    findById: (id, orgId) =>
      Effect.sync(() => {
        const row = store.get(keyFor(id))
        if (!row || row.orgId !== orgId) return null
        return row
      }),

    list: (orgId, params) =>
      Effect.sync(() => {
        const limit = Math.min(params.limit ?? 50, 200)
        let rows = Array.from(store.values())
          .filter((r) => r.orgId === orgId && r.status !== 'deleted')

        if (params.status) {
          rows = rows.filter((r) => r.status === params.status)
        }
        if (params.forked_from) {
          const parentBytes = idToBytes(params.forked_from)
          rows = rows.filter((r) => r.forkedFrom && bytesEqual(r.forkedFrom, parentBytes))
        }

        // Sort by createdAt descending
        rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

        // Cursor-based pagination: cursor is the sandbox ID of the last item
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
          ? bytesToId(SANDBOX_PREFIX, page[page.length - 1].id)
          : null

        return { rows: page, nextCursor }
      }),

    updateStatus: (id, orgId, status, extra) =>
      Effect.sync(() => {
        const key = keyFor(id)
        const row = store.get(key)
        if (!row || row.orgId !== orgId) return null
        const updated: SandboxRow = {
          ...row,
          status,
          updatedAt: new Date(),
          endedAt: extra?.endedAt ?? row.endedAt,
          failureReason: extra?.failureReason ?? row.failureReason,
        }
        store.set(key, updated)
        return updated
      }),

    softDelete: (id, orgId) =>
      Effect.sync(() => {
        const key = keyFor(id)
        const row = store.get(key)
        if (!row || row.orgId !== orgId) return null
        const updated: SandboxRow = {
          ...row,
          status: 'deleted' as SandboxStatus,
          updatedAt: new Date(),
          endedAt: row.endedAt ?? new Date(),
          failureReason: row.failureReason ?? ('sandbox_deleted' as FailureReason),
        }
        store.set(key, updated)
        return updated
      }),

    createFork: (params) =>
      Effect.sync(() => {
        const now = new Date()
        const row: SandboxRow = {
          id: params.id,
          orgId: params.orgId,
          imageId: params.source.imageId,
          profileId: params.source.profileId,
          profileName: params.source.profileName,
          status: 'running',
          env: params.env,
          forkedFrom: params.source.id,
          forkDepth: params.source.forkDepth + 1,
          forkCount: 0,
          ttlSeconds: params.ttlSeconds,
          failureReason: null,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
          endedAt: null,
          imageRef: params.source.imageRef,
        }
        store.set(keyFor(params.id), row)
        return row
      }),

    incrementForkCount: (id, orgId) =>
      Effect.sync(() => {
        const key = keyFor(id)
        const row = store.get(key)
        if (!row || row.orgId !== orgId) return null
        const updated: SandboxRow = {
          ...row,
          forkCount: row.forkCount + 1,
          updatedAt: new Date(),
        }
        store.set(key, updated)
        return updated
      }),

    getForkTree: (id, orgId) =>
      Effect.sync(() => {
        const start = store.get(keyFor(id))
        if (!start || start.orgId !== orgId) return []

        // Walk up to find root
        let root = start
        while (root.forkedFrom) {
          const parent = store.get(keyFor(root.forkedFrom))
          if (!parent || parent.orgId !== orgId) break
          root = parent
        }

        // BFS down from root to find all descendants
        const result: SandboxRow[] = [root]
        const queue = [root]
        while (queue.length > 0) {
          const current = queue.shift()!
          for (const row of store.values()) {
            if (row.forkedFrom && bytesEqual(row.forkedFrom, current.id) && row.orgId === orgId) {
              result.push(row)
              queue.push(row)
            }
          }
        }

        return result
      }),
  }
}

export const SandboxRepoMemory = Layer.sync(SandboxRepo, createInMemorySandboxRepo)
