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
const SEED_PROFILE_SPECS: Record<ProfileName, { cpuCores: number; memoryMb: number; diskGb: number }> = {
  small: { cpuCores: 2, memoryMb: 4096, diskGb: 40 },
  medium: { cpuCores: 4, memoryMb: 8192, diskGb: 80 },
  large: { cpuCores: 8, memoryMb: 16384, diskGb: 160 },
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
          ? {
              id: SEED_IMAGE_ID,
              ref: `sandchest://${imageStr}`,
              kernelRef: 'images/ubuntu-22.04-base/vmlinux',
              rootfsRef: 'images/ubuntu-22.04-base/rootfs.ext4',
            }
          : null,
      ),

    resolveProfile: (name) =>
      Effect.succeed(
        name in SEED_PROFILE_IDS
          ? { id: SEED_PROFILE_IDS[name], ...SEED_PROFILE_SPECS[name] }
          : null,
      ),

    create: (params) =>
      Effect.sync(() => {
        const now = new Date()
        const row: SandboxRow = {
          id: params.id,
          orgId: params.orgId,
          nodeId: null,
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
          replayPublic: false,
          replayExpiresAt: null,
          lastActivityAt: null,
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
          nodeId: params.source.nodeId,
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
          replayPublic: false,
          replayExpiresAt: null,
          lastActivityAt: now,
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

    findByIdPublic: (id) =>
      Effect.sync(() => {
        const row = store.get(keyFor(id))
        if (!row || !row.replayPublic) return null
        return row
      }),

    setReplayPublic: (id, orgId, isPublic) =>
      Effect.sync(() => {
        const key = keyFor(id)
        const row = store.get(key)
        if (!row || row.orgId !== orgId) return null
        const updated: SandboxRow = {
          ...row,
          replayPublic: isPublic,
          updatedAt: new Date(),
        }
        store.set(key, updated)
        return updated
      }),

    findExpiredTtl: () =>
      Effect.sync(() => {
        const now = Date.now()
        return Array.from(store.values()).filter((r) => {
          if (r.status !== 'running' || !r.startedAt) return false
          return r.startedAt.getTime() + r.ttlSeconds * 1000 < now
        })
      }),

    findNearTtlExpiry: (warningThresholdSeconds) =>
      Effect.sync(() => {
        const now = Date.now()
        return Array.from(store.values()).filter((r) => {
          if (r.status !== 'running' || !r.startedAt) return false
          const expiresAt = r.startedAt.getTime() + r.ttlSeconds * 1000
          const warningAt = expiresAt - warningThresholdSeconds * 1000
          return warningAt <= now && expiresAt > now
        })
      }),

    findIdleSince: (cutoff) =>
      Effect.sync(() =>
        Array.from(store.values()).filter((r) => {
          if (r.status !== 'running') return false
          const activity = r.lastActivityAt ?? r.startedAt ?? r.createdAt
          return activity.getTime() < cutoff.getTime()
        }),
      ),

    findQueuedBefore: (cutoff) =>
      Effect.sync(() =>
        Array.from(store.values()).filter(
          (r) => r.status === 'queued' && r.createdAt.getTime() < cutoff.getTime(),
        ),
      ),

    getActiveNodeIds: () =>
      Effect.sync(() => {
        const nodeIds = new Map<string, Uint8Array>()
        for (const row of store.values()) {
          if (row.status === 'running' && row.nodeId) {
            nodeIds.set(base62Encode(row.nodeId), row.nodeId)
          }
        }
        return Array.from(nodeIds.values())
      }),

    findRunningOnNodes: (nodeIds) =>
      Effect.sync(() => {
        if (nodeIds.length === 0) return []
        return Array.from(store.values()).filter((r) => {
          if (r.status !== 'running' || !r.nodeId) return false
          return nodeIds.some((nid) => bytesEqual(r.nodeId!, nid))
        })
      }),

    assignNode: (id, orgId, nodeId) =>
      Effect.sync(() => {
        const key = keyFor(id)
        const row = store.get(key)
        if (!row || row.orgId !== orgId) return null
        const now = new Date()
        const updated: SandboxRow = {
          ...row,
          nodeId,
          status: 'running',
          startedAt: now,
          lastActivityAt: now,
          updatedAt: now,
        }
        store.set(key, updated)
        return updated
      }),

    countActive: (orgId) =>
      Effect.sync(() => {
        const active: SandboxStatus[] = ['queued', 'provisioning', 'running']
        return Array.from(store.values()).filter(
          (r) => r.orgId === orgId && active.includes(r.status),
        ).length
      }),

    findMissingReplayExpiry: () =>
      Effect.sync(() => {
        const terminal: SandboxStatus[] = ['stopped', 'failed']
        return Array.from(store.values()).filter(
          (r) => terminal.includes(r.status) && r.endedAt !== null && r.replayExpiresAt === null,
        )
      }),

    setReplayExpiresAt: (id, expiresAt) =>
      Effect.sync(() => {
        const key = keyFor(id)
        const row = store.get(key)
        if (!row) return
        store.set(key, { ...row, replayExpiresAt: expiresAt, updatedAt: new Date() })
      }),

    findPurgableReplays: (cutoff, minDate) =>
      Effect.sync(() =>
        Array.from(store.values()).filter((r) => {
          if (!r.replayExpiresAt) return false
          return r.replayExpiresAt.getTime() > minDate.getTime() &&
            r.replayExpiresAt.getTime() <= cutoff.getTime()
        }),
      ),

    deleteByOrgId: (orgId) =>
      Effect.sync(() => {
        let deleted = 0
        for (const [key, row] of store) {
          if (row.orgId === orgId) {
            store.delete(key)
            deleted++
          }
        }
        return deleted
      }),

    touchLastActivity: (id, orgId) =>
      Effect.sync(() => {
        const key = keyFor(id)
        const row = store.get(key)
        if (!row || row.orgId !== orgId || row.status !== 'running') return
        const now = new Date()
        store.set(key, { ...row, lastActivityAt: now, updatedAt: now })
      }),
  }
}

export const SandboxRepoMemory = Layer.sync(SandboxRepo, createInMemorySandboxRepo)
