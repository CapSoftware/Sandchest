import { Effect, Layer } from 'effect'
import { base62Encode, bytesToId, EXEC_PREFIX, idToBytes } from '@sandchest/contract'
import { ExecRepo, type ExecRow, type ExecRepoApi } from './exec-repo.js'

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function createInMemoryExecRepo(): ExecRepoApi {
  const store = new Map<string, ExecRow>()
  const seqCounters = new Map<string, number>()

  function keyFor(id: Uint8Array): string {
    return base62Encode(id)
  }

  function sandboxKey(sandboxId: Uint8Array): string {
    return base62Encode(sandboxId)
  }

  return {
    create: (params) =>
      Effect.sync(() => {
        const now = new Date()
        const row: ExecRow = {
          id: params.id,
          sandboxId: params.sandboxId,
          orgId: params.orgId,
          sessionId: params.sessionId ?? null,
          seq: params.seq,
          cmd: params.cmd,
          cmdFormat: params.cmdFormat,
          cwd: params.cwd ?? null,
          env: params.env ?? null,
          status: 'queued',
          exitCode: null,
          cpuMs: null,
          peakMemoryBytes: null,
          durationMs: null,
          logRef: null,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          endedAt: null,
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
        let rows = Array.from(store.values()).filter(
          (r) => bytesEqual(r.sandboxId, sandboxId) && r.orgId === orgId,
        )

        if (params.status) {
          rows = rows.filter((r) => r.status === params.status)
        }
        if (params.sessionId) {
          rows = rows.filter(
            (r) => r.sessionId !== null && bytesEqual(r.sessionId, params.sessionId!),
          )
        }

        // Sort by seq ascending
        rows.sort((a, b) => a.seq - b.seq)

        // Cursor-based pagination
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
          ? bytesToId(EXEC_PREFIX, page[page.length - 1].id)
          : null

        return { rows: page, nextCursor }
      }),

    updateStatus: (id, status, extra) =>
      Effect.sync(() => {
        const key = keyFor(id)
        const row = store.get(key)
        if (!row) return null
        const updated: ExecRow = {
          ...row,
          status,
          updatedAt: new Date(),
          exitCode: extra?.exitCode ?? row.exitCode,
          cpuMs: extra?.cpuMs ?? row.cpuMs,
          peakMemoryBytes: extra?.peakMemoryBytes ?? row.peakMemoryBytes,
          durationMs: extra?.durationMs ?? row.durationMs,
          startedAt: extra?.startedAt ?? row.startedAt,
          endedAt: extra?.endedAt ?? row.endedAt,
        }
        store.set(key, updated)
        return updated
      }),

    nextSeq: (sandboxId) =>
      Effect.sync(() => {
        const key = sandboxKey(sandboxId)
        const current = seqCounters.get(key) ?? 0
        const next = current + 1
        seqCounters.set(key, next)
        return next
      }),
  }
}

export const ExecRepoMemory = Layer.sync(ExecRepo, createInMemoryExecRepo)
