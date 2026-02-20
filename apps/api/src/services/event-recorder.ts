import { Context, type Effect } from 'effect'
import type { ReplayEvent, ExecOutputEntry } from '@sandchest/contract'
import type { EventPayload } from './events.js'

/**
 * Event recorder service — dual-writes replay events to object storage
 * (durable) and Redis (ephemeral, for live replay).
 *
 * Object storage keys follow the spec bucket layout:
 *   {org_id}/{sandbox_id}/events.jsonl
 *   {org_id}/{sandbox_id}/exec/{exec_id}.log
 */
export interface EventRecorderApi {
  /**
   * Record a replay event for a sandbox.
   * Assigns monotonic sequence number and ISO timestamp,
   * pushes to Redis immediately, and buffers for object storage.
   */
  readonly record: (params: {
    sandboxId: string
    orgId: string
    event: EventPayload
  }) => Effect.Effect<ReplayEvent, never, never>

  /**
   * Record exec output to a separate per-exec log file.
   * Pushed to Redis immediately and buffered for object storage.
   */
  readonly recordExecOutput: (params: {
    sandboxId: string
    orgId: string
    execId: string
    stream: 'stdout' | 'stderr'
    data: string
  }) => Effect.Effect<ExecOutputEntry, never, never>

  /**
   * Flush all buffered events and exec output to object storage.
   * Call on sandbox terminal state (stopped/failed/deleted).
   */
  readonly flush: (params: {
    sandboxId: string
    orgId: string
  }) => Effect.Effect<void, never, never>

  /**
   * Get all replay events for a sandbox from the buffer/storage.
   * Reads from Redis first (live), falls back to object storage.
   */
  readonly getEvents: (params: {
    sandboxId: string
    orgId: string
  }) => Effect.Effect<ReplayEvent[], never, never>
}

export class EventRecorder extends Context.Tag('EventRecorder')<EventRecorder, EventRecorderApi>() {}
