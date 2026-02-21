import { Effect, Layer } from 'effect'
import type { ReplayEvent, ExecOutputEntry } from '@sandchest/contract'
import { EventRecorder, type EventRecorderApi } from './event-recorder.js'
import { ObjectStorage } from './object-storage.js'
import { RedisService } from './redis.js'

/** TTL for replay events in Redis: sandbox lifetime + 10 min buffer. */
const REPLAY_EVENT_TTL_SECONDS = 4200

/** Flush buffered events to S3 when buffer exceeds this size. */
const FLUSH_THRESHOLD_BYTES = 64 * 1024

function eventsKey(orgId: string, sandboxId: string): string {
  return `${orgId}/${sandboxId}/events.jsonl`
}

function execOutputKey(orgId: string, sandboxId: string, execId: string): string {
  return `${orgId}/${sandboxId}/exec/${execId}.log`
}

/** Internal per-sandbox state for buffering and sequence tracking. */
interface SandboxBuffer {
  seq: number
  lines: string[]
  bytesBuffered: number
  execOutputs: Map<string, { seq: number; lines: string[] }>
}

export function createLiveEventRecorder(
  objectStorage: ObjectStorage['Type'],
  redis: RedisService['Type'],
): EventRecorderApi {
  const buffers = new Map<string, SandboxBuffer>()

  function getBuffer(sandboxId: string): SandboxBuffer {
    let buf = buffers.get(sandboxId)
    if (!buf) {
      buf = { seq: 0, lines: [], bytesBuffered: 0, execOutputs: new Map() }
      buffers.set(sandboxId, buf)
    }
    return buf
  }

  function getExecBuffer(sandboxId: string, execId: string): { seq: number; lines: string[] } {
    const buf = getBuffer(sandboxId)
    let execBuf = buf.execOutputs.get(execId)
    if (!execBuf) {
      execBuf = { seq: 0, lines: [] }
      buf.execOutputs.set(execId, execBuf)
    }
    return execBuf
  }

  function shouldFlush(buf: SandboxBuffer): boolean {
    return buf.bytesBuffered >= FLUSH_THRESHOLD_BYTES
  }

  function flushEvents(orgId: string, sandboxId: string, buf: SandboxBuffer) {
    return Effect.gen(function* () {
      if (buf.lines.length === 0) return

      const key = eventsKey(orgId, sandboxId)
      const existing = yield* objectStorage.getObject(key)
      const content = existing
        ? existing + buf.lines.join('\n') + '\n'
        : buf.lines.join('\n') + '\n'

      yield* objectStorage.putObject(key, content)
      buf.lines = []
      buf.bytesBuffered = 0
    })
  }

  function flushExecOutputs(orgId: string, sandboxId: string, buf: SandboxBuffer) {
    return Effect.gen(function* () {
      for (const [execId, execBuf] of buf.execOutputs) {
        if (execBuf.lines.length === 0) continue

        const key = execOutputKey(orgId, sandboxId, execId)
        const existing = yield* objectStorage.getObject(key)
        const content = existing
          ? existing + execBuf.lines.join('\n') + '\n'
          : execBuf.lines.join('\n') + '\n'

        yield* objectStorage.putObject(key, content)
        execBuf.lines = []
      }
    })
  }

  return {
    record: (params) =>
      Effect.gen(function* () {
        const buf = getBuffer(params.sandboxId)
        buf.seq++

        const event: ReplayEvent = {
          ts: new Date().toISOString(),
          seq: buf.seq,
          type: params.event.type,
          data: params.event.data,
        }

        const line = JSON.stringify(event)
        buf.lines.push(line)
        buf.bytesBuffered += line.length

        // Push to Redis for live replay
        yield* redis.pushReplayEvent(
          params.sandboxId,
          { seq: event.seq, ts: event.ts, data: event },
          REPLAY_EVENT_TTL_SECONDS,
        )

        // Auto-flush if buffer exceeds threshold
        if (shouldFlush(buf)) {
          yield* flushEvents(params.orgId, params.sandboxId, buf)
        }

        return event
      }),

    recordExecOutput: (params) =>
      Effect.gen(function* () {
        const execBuf = getExecBuffer(params.sandboxId, params.execId)
        execBuf.seq++

        const entry: ExecOutputEntry = {
          ts: new Date().toISOString(),
          seq: execBuf.seq,
          stream: params.stream,
          data: params.data,
        }

        execBuf.lines.push(JSON.stringify(entry))

        // Also record as a replay event in the main event log
        const buf = getBuffer(params.sandboxId)
        buf.seq++

        const event: ReplayEvent = {
          ts: entry.ts,
          seq: buf.seq,
          type: 'exec.output',
          data: {
            exec_id: params.execId,
            stream: params.stream,
            data: params.data,
          },
        }

        const line = JSON.stringify(event)
        buf.lines.push(line)
        buf.bytesBuffered += line.length

        yield* redis.pushReplayEvent(
          params.sandboxId,
          { seq: event.seq, ts: event.ts, data: event },
          REPLAY_EVENT_TTL_SECONDS,
        )

        if (shouldFlush(buf)) {
          yield* flushEvents(params.orgId, params.sandboxId, buf)
        }

        return entry
      }),

    flush: (params) =>
      Effect.gen(function* () {
        const buf = buffers.get(params.sandboxId)
        if (!buf) return

        yield* flushEvents(params.orgId, params.sandboxId, buf)
        yield* flushExecOutputs(params.orgId, params.sandboxId, buf)
      }),

    getEvents: (params) =>
      Effect.gen(function* () {
        // Try Redis first (for live/recent sandboxes)
        const redisEvents = yield* redis.getReplayEvents(params.sandboxId, 0)
        if (redisEvents.length > 0) {
          return redisEvents.map((e) => e.data as ReplayEvent)
        }

        // Fall back to object storage
        const key = eventsKey(params.orgId, params.sandboxId)
        const content = yield* objectStorage.getObject(key)
        if (!content) return []

        return content
          .trim()
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as ReplayEvent)
      }),
  }
}

export const EventRecorderLive = Layer.effect(
  EventRecorder,
  Effect.gen(function* () {
    const objectStorage = yield* ObjectStorage
    const redis = yield* RedisService
    return createLiveEventRecorder(objectStorage, redis)
  }),
)
