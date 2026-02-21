import { Effect, Layer } from 'effect'
import { RedisService, type RedisApi, type BufferedEvent } from './redis.js'

interface SlotEntry {
  sandboxId: string
  expiresAt: number
}

interface RateEntry {
  timestamps: number[]
}

/** In-memory Redis implementation for testing. */
export function createInMemoryRedisApi(): RedisApi {
  const slots = new Map<string, SlotEntry>()
  const rateLimits = new Map<string, RateEntry>()
  const execEvents = new Map<string, BufferedEvent[]>()
  const replayEvents = new Map<string, BufferedEvent[]>()
  const artifactPaths = new Map<string, Set<string>>()

  function isExpired(entry: SlotEntry): boolean {
    return Date.now() >= entry.expiresAt
  }

  function cleanExpiredSlots(): void {
    for (const [key, entry] of slots) {
      if (isExpired(entry)) {
        slots.delete(key)
      }
    }
  }

  return {
    acquireSlotLease: (nodeId, slot, sandboxId, ttlSeconds) =>
      Effect.sync(() => {
        cleanExpiredSlots()
        const key = `slot:${nodeId}:${slot}`
        const existing = slots.get(key)
        if (existing && !isExpired(existing)) {
          return false
        }
        slots.set(key, {
          sandboxId,
          expiresAt: Date.now() + ttlSeconds * 1000,
        })
        return true
      }),

    releaseSlotLease: (nodeId, slot) =>
      Effect.sync(() => {
        slots.delete(`slot:${nodeId}:${slot}`)
      }),

    renewSlotLease: (nodeId, slot, ttlSeconds) =>
      Effect.sync(() => {
        const key = `slot:${nodeId}:${slot}`
        const entry = slots.get(key)
        if (!entry || isExpired(entry)) return false
        entry.expiresAt = Date.now() + ttlSeconds * 1000
        return true
      }),

    checkRateLimit: (orgId, category, limit, windowSeconds) =>
      Effect.sync(() => {
        const key = `rate:${orgId}:${category}`
        const now = Date.now()
        const windowMs = windowSeconds * 1000
        const windowStart = now - windowMs

        let entry = rateLimits.get(key)
        if (!entry) {
          entry = { timestamps: [] }
          rateLimits.set(key, entry)
        }

        // Remove expired entries
        entry.timestamps = entry.timestamps.filter((t) => t > windowStart)

        // Add current request
        entry.timestamps.push(now)
        const count = entry.timestamps.length
        const allowed = count <= limit
        const remaining = Math.max(0, limit - count)
        const resetAt = now + windowMs

        if (!allowed) {
          // Remove the entry we just added since request is rejected
          entry.timestamps.pop()
        }

        return { allowed, remaining, resetAt }
      }),

    pushExecEvent: (_execId, event, _ttlSeconds) =>
      Effect.sync(() => {
        const events = execEvents.get(_execId) ?? []
        events.push(event)
        execEvents.set(_execId, events)
      }),

    getExecEvents: (execId, afterSeq) =>
      Effect.sync(() => {
        const events = execEvents.get(execId) ?? []
        return events.filter((e) => e.seq > afterSeq)
      }),

    pushReplayEvent: (sandboxId, event, _ttlSeconds) =>
      Effect.sync(() => {
        const events = replayEvents.get(sandboxId) ?? []
        events.push(event)
        replayEvents.set(sandboxId, events)
      }),

    getReplayEvents: (sandboxId) =>
      Effect.sync(() => replayEvents.get(sandboxId) ?? []),

    addArtifactPaths: (sandboxId, paths) =>
      Effect.sync(() => {
        const key = `artifact_paths:${sandboxId}`
        let set = artifactPaths.get(key)
        if (!set) {
          set = new Set()
          artifactPaths.set(key, set)
        }
        let added = 0
        for (const p of paths) {
          if (!set.has(p)) {
            set.add(p)
            added++
          }
        }
        return added
      }),

    getArtifactPaths: (sandboxId) =>
      Effect.sync(() => {
        const key = `artifact_paths:${sandboxId}`
        const set = artifactPaths.get(key)
        return set ? Array.from(set) : []
      }),

    countArtifactPaths: (sandboxId) =>
      Effect.sync(() => {
        const key = `artifact_paths:${sandboxId}`
        return artifactPaths.get(key)?.size ?? 0
      }),

    ping: () => Effect.succeed(true),
  }
}

export const RedisMemory = Layer.sync(RedisService, createInMemoryRedisApi)
