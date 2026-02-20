import { Context, type Effect } from 'effect'

/** Serialized event stored in Redis lists. */
export interface BufferedEvent {
  readonly seq: number
  readonly ts: string
  readonly data: unknown
}

/** Result of a rate limit check. */
export interface RateLimitResult {
  readonly allowed: boolean
  readonly remaining: number
  readonly resetAt: number
}

/** Redis utility layer API surface. */
export interface RedisApi {
  /** Acquire an atomic slot lease. Returns true if acquired. */
  readonly acquireSlotLease: (
    nodeId: string,
    slot: number,
    sandboxId: string,
    ttlSeconds: number,
  ) => Effect.Effect<boolean, never, never>

  /** Release a slot lease. */
  readonly releaseSlotLease: (
    nodeId: string,
    slot: number,
  ) => Effect.Effect<void, never, never>

  /** Renew an existing slot lease TTL. */
  readonly renewSlotLease: (
    nodeId: string,
    slot: number,
    ttlSeconds: number,
  ) => Effect.Effect<boolean, never, never>

  /** Check and decrement rate limit. Uses sliding window counter. */
  readonly checkRateLimit: (
    orgId: string,
    category: string,
    limit: number,
    windowSeconds: number,
  ) => Effect.Effect<RateLimitResult, never, never>

  /** Push an exec event to the buffer list. */
  readonly pushExecEvent: (
    execId: string,
    event: BufferedEvent,
    ttlSeconds: number,
  ) => Effect.Effect<void, never, never>

  /** Get exec events after a given sequence number. */
  readonly getExecEvents: (
    execId: string,
    afterSeq: number,
  ) => Effect.Effect<BufferedEvent[], never, never>

  /** Push a replay event. */
  readonly pushReplayEvent: (
    sandboxId: string,
    event: BufferedEvent,
    ttlSeconds: number,
  ) => Effect.Effect<void, never, never>

  /** Get all replay events for a sandbox. */
  readonly getReplayEvents: (
    sandboxId: string,
  ) => Effect.Effect<BufferedEvent[], never, never>

  /** Ping to check connectivity. */
  readonly ping: () => Effect.Effect<boolean, never, never>
}

export class RedisService extends Context.Tag('RedisService')<RedisService, RedisApi>() {}
