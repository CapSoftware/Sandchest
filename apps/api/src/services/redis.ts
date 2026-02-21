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

  /** Get replay events for a sandbox after a given sequence number. */
  readonly getReplayEvents: (
    sandboxId: string,
    afterSeq: number,
  ) => Effect.Effect<BufferedEvent[], never, never>

  /** Add paths to the artifact registration set for a sandbox. Returns the number of new paths added. */
  readonly addArtifactPaths: (
    sandboxId: string,
    paths: string[],
  ) => Effect.Effect<number, never, never>

  /** Get all registered artifact paths for a sandbox. */
  readonly getArtifactPaths: (
    sandboxId: string,
  ) => Effect.Effect<string[], never, never>

  /** Get the count of registered artifact paths for a sandbox. */
  readonly countArtifactPaths: (
    sandboxId: string,
  ) => Effect.Effect<number, never, never>

  /** Acquire a worker leader lock. Returns true if this instance became the leader. */
  readonly acquireLeaderLock: (
    workerName: string,
    instanceId: string,
    ttlMs: number,
  ) => Effect.Effect<boolean, never, never>

  /** Register a node heartbeat with a TTL. */
  readonly registerNodeHeartbeat: (
    nodeId: string,
    ttlSeconds: number,
  ) => Effect.Effect<void, never, never>

  /** Check if a node has an active heartbeat. */
  readonly hasNodeHeartbeat: (
    nodeId: string,
  ) => Effect.Effect<boolean, never, never>

  /** Atomically mark a sandbox as TTL-warned. Returns true if newly marked. */
  readonly markTtlWarned: (
    sandboxId: string,
    ttlSeconds: number,
  ) => Effect.Effect<boolean, never, never>

  /** Ping to check connectivity. */
  readonly ping: () => Effect.Effect<boolean, never, never>
}

export class RedisService extends Context.Tag('RedisService')<RedisService, RedisApi>() {}
