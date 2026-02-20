import IoRedis from 'ioredis'
import type { Redis } from 'ioredis'
import { Effect, Layer } from 'effect'
import { RedisService, type RedisApi, type BufferedEvent } from './redis.js'

function slotKey(nodeId: string, slot: number): string {
  return `slot:${nodeId}:${slot}`
}

function rateKey(orgId: string, category: string): string {
  return `rate:${orgId}:${category}`
}

function execEventsKey(execId: string): string {
  return `exec_events:${execId}`
}

function replayEventsKey(sandboxId: string): string {
  return `replay_events:${sandboxId}`
}

export function createIoRedisApi(client: Redis): RedisApi {
  return {
    acquireSlotLease: (nodeId, slot, sandboxId, ttlSeconds) =>
      Effect.promise(async () => {
        const key = slotKey(nodeId, slot)
        const result = await client.set(key, sandboxId, 'EX', ttlSeconds, 'NX')
        return result === 'OK'
      }),

    releaseSlotLease: (nodeId, slot) =>
      Effect.promise(async () => {
        await client.del(slotKey(nodeId, slot))
      }),

    renewSlotLease: (nodeId, slot, ttlSeconds) =>
      Effect.promise(async () => {
        const result = await client.expire(slotKey(nodeId, slot), ttlSeconds)
        return result === 1
      }),

    checkRateLimit: (orgId, category, limit, windowSeconds) =>
      Effect.promise(async () => {
        const key = rateKey(orgId, category)
        const now = Date.now()
        const windowMs = windowSeconds * 1000
        const windowStart = now - windowMs

        // Sliding window: remove old entries, add current, count
        const pipeline = client.pipeline()
        pipeline.zremrangebyscore(key, 0, windowStart)
        pipeline.zadd(key, now.toString(), `${now}:${Math.random()}`)
        pipeline.zcard(key)
        pipeline.pexpire(key, windowMs)
        const results = await pipeline.exec()

        const count = (results?.[2]?.[1] as number) ?? 0
        const allowed = count <= limit
        const remaining = Math.max(0, limit - count)
        const resetAt = now + windowMs

        if (!allowed) {
          // Remove the entry we just added since request is rejected
          await client.zremrangebyscore(key, now, now + 1)
        }

        return { allowed, remaining, resetAt }
      }),

    pushExecEvent: (execId, event, ttlSeconds) =>
      Effect.promise(async () => {
        const key = execEventsKey(execId)
        await client.rpush(key, JSON.stringify(event))
        await client.expire(key, ttlSeconds)
      }),

    getExecEvents: (execId, afterSeq) =>
      Effect.promise(async () => {
        const key = execEventsKey(execId)
        const raw = await client.lrange(key, 0, -1)
        const events: BufferedEvent[] = raw.map((s: string) => JSON.parse(s) as BufferedEvent)
        return events.filter((e) => e.seq > afterSeq)
      }),

    pushReplayEvent: (sandboxId, event, ttlSeconds) =>
      Effect.promise(async () => {
        const key = replayEventsKey(sandboxId)
        await client.rpush(key, JSON.stringify(event))
        await client.expire(key, ttlSeconds)
      }),

    getReplayEvents: (sandboxId) =>
      Effect.promise(async () => {
        const key = replayEventsKey(sandboxId)
        const raw = await client.lrange(key, 0, -1)
        return raw.map((s: string) => JSON.parse(s) as BufferedEvent)
      }),

    ping: () =>
      Effect.promise(async () => {
        try {
          const result = await client.ping()
          return result === 'PONG'
        } catch {
          return false
        }
      }),
  }
}

/** Create a RedisService Layer from a REDIS_URL. */
export function createRedisLayer(redisUrl: string): Layer.Layer<RedisService> {
  return Layer.sync(RedisService, () => {
    // ioredis CJS/ESM interop: handle both default and named exports
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = (IoRedis as any).default ?? IoRedis
    const client: Redis = new Ctor(redisUrl, { maxRetriesPerRequest: 3 })
    return createIoRedisApi(client)
  })
}
