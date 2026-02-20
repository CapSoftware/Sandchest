import { Context, Effect } from 'effect'
import { RedisService } from './redis.js'
import { NoCapacityError } from '../errors.js'

/** Minimal node info needed by the scheduler. */
export interface SchedulerNode {
  readonly id: string
  readonly slotsTotal: number
  readonly status: 'online' | 'offline' | 'draining' | 'disabled'
}

/** Successful scheduling result. */
export interface ScheduleResult {
  readonly nodeId: string
  readonly slot: number
}

/** Provides the list of online nodes. Decoupled from DB for testability. */
export interface NodeLookupApi {
  readonly getOnlineNodes: () => Effect.Effect<SchedulerNode[], never, never>
}

export class NodeLookup extends Context.Tag('NodeLookup')<NodeLookup, NodeLookupApi>() {}

const SLOT_LEASE_TTL = 60

/**
 * Schedule a sandbox to a node with an available slot.
 *
 * Tries each online node in order, attempting to acquire a slot lease
 * via Redis SETNX. Returns the first successful assignment.
 */
export function schedule(
  sandboxId: string,
): Effect.Effect<ScheduleResult, NoCapacityError, RedisService | NodeLookup> {
  return Effect.gen(function* () {
    const redis = yield* RedisService
    const nodeLookup = yield* NodeLookup

    const nodes = yield* nodeLookup.getOnlineNodes()
    if (nodes.length === 0) {
      return yield* Effect.fail(
        new NoCapacityError({ message: 'No online nodes available' }),
      )
    }

    for (const node of nodes) {
      for (let slot = 0; slot < node.slotsTotal; slot++) {
        const acquired = yield* redis.acquireSlotLease(
          node.id,
          slot,
          sandboxId,
          SLOT_LEASE_TTL,
        )
        if (acquired) {
          return { nodeId: node.id, slot }
        }
      }
    }

    return yield* Effect.fail(
      new NoCapacityError({ message: 'All nodes are at capacity' }),
    )
  })
}

/** Release a slot lease when a sandbox is stopped/deleted. */
export function releaseSlot(
  nodeId: string,
  slot: number,
): Effect.Effect<void, never, RedisService> {
  return Effect.gen(function* () {
    const redis = yield* RedisService
    yield* redis.releaseSlotLease(nodeId, slot)
  })
}

/** Renew a slot lease. Call periodically while sandbox is active. */
export function renewSlot(
  nodeId: string,
  slot: number,
): Effect.Effect<boolean, never, RedisService> {
  return Effect.gen(function* () {
    const redis = yield* RedisService
    return yield* redis.renewSlotLease(nodeId, slot, SLOT_LEASE_TTL)
  })
}
