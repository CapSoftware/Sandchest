import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import type { ReplayEvent, ExecOutputEntry } from '@sandchest/contract'
import { createLiveEventRecorder } from './event-recorder.live.js'
import { createInMemoryObjectStorage } from './object-storage.memory.js'
import { createInMemoryRedisApi } from './redis.memory.js'
import {
  sandboxCreated,
  sandboxReady,
  execStarted,
  execCompleted,
  sandboxStopped,
} from './events.js'

function createTestRecorder() {
  const objectStorage = createInMemoryObjectStorage()
  const redis = createInMemoryRedisApi()
  const recorder = createLiveEventRecorder(objectStorage, redis)
  return { recorder, objectStorage, redis }
}

function run<A>(effect: Effect.Effect<A, never, never>): Promise<A> {
  return Effect.runPromise(effect)
}

const TEST_SANDBOX = 'sb_test123'
const TEST_ORG = 'org_test456'

describe('EventRecorder', () => {
  test('record assigns monotonically increasing sequence numbers', async () => {
    const { recorder } = createTestRecorder()

    const event1 = await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: sandboxCreated({
          image: 'sandchest://ubuntu-22.04/base',
          profile: 'small',
          env: null,
          forked_from: null,
        }),
      }),
    )

    const event2 = await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: sandboxReady({ boot_duration_ms: 1200 }),
      }),
    )

    expect(event1.seq).toBe(1)
    expect(event2.seq).toBe(2)
    expect(event2.seq).toBeGreaterThan(event1.seq)
  })

  test('record produces valid ReplayEvent format', async () => {
    const { recorder } = createTestRecorder()

    const event = await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: sandboxCreated({
          image: 'sandchest://ubuntu-22.04/node-22',
          profile: 'small',
          env: { SECRET: 'value' },
          forked_from: null,
        }),
      }),
    )

    expect(event.ts).toBeDefined()
    expect(event.seq).toBe(1)
    expect(event.type).toBe('sandbox.created')
    expect(event.data.image).toBe('sandchest://ubuntu-22.04/node-22')
    expect(event.data.profile).toBe('small')
    expect((event.data.env as Record<string, string>).SECRET).toBe('[REDACTED]')
    // Validate ISO 8601 timestamp
    expect(new Date(event.ts).toISOString()).toBe(event.ts)
  })

  test('record pushes to Redis for live replay', async () => {
    const { recorder, redis } = createTestRecorder()

    await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: sandboxCreated({
          image: 'img',
          profile: 'small',
          env: null,
          forked_from: null,
        }),
      }),
    )

    const events = await run(redis.getReplayEvents(TEST_SANDBOX))
    expect(events.length).toBe(1)
    const stored = events[0].data as ReplayEvent
    expect(stored.type).toBe('sandbox.created')
    expect(stored.seq).toBe(1)
  })

  test('sequence numbers are independent per sandbox', async () => {
    const { recorder } = createTestRecorder()

    const event1 = await run(
      recorder.record({
        sandboxId: 'sb_sandbox_a',
        orgId: TEST_ORG,
        event: sandboxReady({ boot_duration_ms: 100 }),
      }),
    )

    const event2 = await run(
      recorder.record({
        sandboxId: 'sb_sandbox_b',
        orgId: TEST_ORG,
        event: sandboxReady({ boot_duration_ms: 200 }),
      }),
    )

    expect(event1.seq).toBe(1)
    expect(event2.seq).toBe(1)
  })

  test('flush writes buffered events to object storage as JSONL', async () => {
    const { recorder, objectStorage } = createTestRecorder()

    await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: sandboxCreated({ image: 'img', profile: 'small', env: null, forked_from: null }),
      }),
    )
    await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: sandboxReady({ boot_duration_ms: 500 }),
      }),
    )
    await run(recorder.flush({ sandboxId: TEST_SANDBOX, orgId: TEST_ORG }))

    const content = await run(objectStorage.getObject(`${TEST_ORG}/${TEST_SANDBOX}/events.jsonl`))
    expect(content).not.toBeNull()

    const lines = content!.trim().split('\n')
    expect(lines.length).toBe(2)

    const parsed1 = JSON.parse(lines[0]) as ReplayEvent
    expect(parsed1.seq).toBe(1)
    expect(parsed1.type).toBe('sandbox.created')

    const parsed2 = JSON.parse(lines[1]) as ReplayEvent
    expect(parsed2.seq).toBe(2)
    expect(parsed2.type).toBe('sandbox.ready')
  })

  test('flush is idempotent — second flush with no new events writes nothing extra', async () => {
    const { recorder, objectStorage } = createTestRecorder()

    await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: sandboxReady({ boot_duration_ms: 100 }),
      }),
    )

    await run(recorder.flush({ sandboxId: TEST_SANDBOX, orgId: TEST_ORG }))
    const content1 = await run(objectStorage.getObject(`${TEST_ORG}/${TEST_SANDBOX}/events.jsonl`))

    await run(recorder.flush({ sandboxId: TEST_SANDBOX, orgId: TEST_ORG }))
    const content2 = await run(objectStorage.getObject(`${TEST_ORG}/${TEST_SANDBOX}/events.jsonl`))

    expect(content1).toBe(content2)
  })

  test('flush appends to existing object storage content', async () => {
    const { recorder, objectStorage } = createTestRecorder()

    await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: sandboxCreated({ image: 'img', profile: 'small', env: null, forked_from: null }),
      }),
    )
    await run(recorder.flush({ sandboxId: TEST_SANDBOX, orgId: TEST_ORG }))

    await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: sandboxStopped({ total_duration_ms: 5000 }),
      }),
    )
    await run(recorder.flush({ sandboxId: TEST_SANDBOX, orgId: TEST_ORG }))

    const content = await run(objectStorage.getObject(`${TEST_ORG}/${TEST_SANDBOX}/events.jsonl`))
    const lines = content!.trim().split('\n')
    expect(lines.length).toBe(2)

    const parsed1 = JSON.parse(lines[0]) as ReplayEvent
    expect(parsed1.type).toBe('sandbox.created')
    const parsed2 = JSON.parse(lines[1]) as ReplayEvent
    expect(parsed2.type).toBe('sandbox.stopped')
  })

  test('flush on unknown sandbox is a no-op', async () => {
    const { recorder } = createTestRecorder()
    // Should not throw
    await run(recorder.flush({ sandboxId: 'sb_unknown', orgId: TEST_ORG }))
  })

  test('recordExecOutput writes to separate per-exec file', async () => {
    const { recorder, objectStorage } = createTestRecorder()

    const entry = await run(
      recorder.recordExecOutput({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        execId: 'ex_test789',
        stream: 'stdout',
        data: 'Cloning into /work...\n',
      }),
    )

    expect(entry.seq).toBe(1)
    expect(entry.stream).toBe('stdout')
    expect(entry.data).toBe('Cloning into /work...\n')
    expect(new Date(entry.ts).toISOString()).toBe(entry.ts)

    await run(recorder.flush({ sandboxId: TEST_SANDBOX, orgId: TEST_ORG }))

    const content = await run(
      objectStorage.getObject(`${TEST_ORG}/${TEST_SANDBOX}/exec/ex_test789.log`),
    )
    expect(content).not.toBeNull()

    const parsed = JSON.parse(content!.trim()) as ExecOutputEntry
    expect(parsed.stream).toBe('stdout')
    expect(parsed.data).toBe('Cloning into /work...\n')
  })

  test('recordExecOutput also records exec.output in main event log', async () => {
    const { recorder, redis } = createTestRecorder()

    await run(
      recorder.recordExecOutput({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        execId: 'ex_test789',
        stream: 'stderr',
        data: 'warning: something\n',
      }),
    )

    const events = await run(redis.getReplayEvents(TEST_SANDBOX))
    expect(events.length).toBe(1)
    const stored = events[0].data as ReplayEvent
    expect(stored.type).toBe('exec.output')
    expect(stored.data.exec_id).toBe('ex_test789')
    expect(stored.data.stream).toBe('stderr')
  })

  test('exec output sequences are independent per exec', async () => {
    const { recorder } = createTestRecorder()

    const entry1 = await run(
      recorder.recordExecOutput({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        execId: 'ex_first',
        stream: 'stdout',
        data: 'line 1\n',
      }),
    )

    const entry2 = await run(
      recorder.recordExecOutput({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        execId: 'ex_second',
        stream: 'stdout',
        data: 'line 1\n',
      }),
    )

    expect(entry1.seq).toBe(1)
    expect(entry2.seq).toBe(1)
  })

  test('getEvents reads from Redis when available', async () => {
    const { recorder } = createTestRecorder()

    await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: sandboxCreated({ image: 'img', profile: 'small', env: null, forked_from: null }),
      }),
    )
    await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: sandboxReady({ boot_duration_ms: 100 }),
      }),
    )

    const events = await run(recorder.getEvents({ sandboxId: TEST_SANDBOX, orgId: TEST_ORG }))
    expect(events.length).toBe(2)
    expect(events[0].type).toBe('sandbox.created')
    expect(events[1].type).toBe('sandbox.ready')
  })

  test('getEvents falls back to object storage when Redis is empty', async () => {
    const { recorder, objectStorage } = createTestRecorder()

    // Manually write to object storage to simulate post-TTL state
    const event: ReplayEvent = {
      ts: new Date().toISOString(),
      seq: 1,
      type: 'sandbox.created',
      data: { image: 'img', profile: 'small' },
    }
    await run(
      objectStorage.putObject(
        `${TEST_ORG}/${TEST_SANDBOX}/events.jsonl`,
        JSON.stringify(event) + '\n',
      ),
    )

    // Redis is empty — should fall back to object storage
    const events = await run(recorder.getEvents({ sandboxId: TEST_SANDBOX, orgId: TEST_ORG }))
    expect(events.length).toBe(1)
    expect(events[0].type).toBe('sandbox.created')
  })

  test('getEvents returns empty array for unknown sandbox', async () => {
    const { recorder } = createTestRecorder()
    const events = await run(recorder.getEvents({ sandboxId: 'sb_unknown', orgId: TEST_ORG }))
    expect(events).toEqual([])
  })

  test('full lifecycle: create → exec → output → complete → stop → flush', async () => {
    const { recorder, objectStorage } = createTestRecorder()

    await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: sandboxCreated({
          image: 'sandchest://ubuntu-22.04/node-22',
          profile: 'small',
          env: { NODE_ENV: 'test' },
          forked_from: null,
        }),
      }),
    )

    await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: sandboxReady({ boot_duration_ms: 1200 }),
      }),
    )

    await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: execStarted({
          exec_id: 'ex_abc',
          cmd: ['npm', 'test'],
          cwd: '/work',
          session_id: null,
        }),
      }),
    )

    await run(
      recorder.recordExecOutput({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        execId: 'ex_abc',
        stream: 'stdout',
        data: 'PASS src/index.test.ts\n',
      }),
    )

    await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: execCompleted({
          exec_id: 'ex_abc',
          exit_code: 0,
          duration_ms: 3500,
          resource_usage: { cpu_ms: 2000, peak_memory_bytes: 67108864 },
        }),
      }),
    )

    await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: sandboxStopped({ total_duration_ms: 10000 }),
      }),
    )

    await run(recorder.flush({ sandboxId: TEST_SANDBOX, orgId: TEST_ORG }))

    // Verify main event log
    const eventsContent = await run(
      objectStorage.getObject(`${TEST_ORG}/${TEST_SANDBOX}/events.jsonl`),
    )
    expect(eventsContent).not.toBeNull()
    const lines = eventsContent!.trim().split('\n')
    // 5 explicit record() calls + 1 exec.output from recordExecOutput() = 6 lines
    expect(lines.length).toBe(6)

    const events = lines.map((l) => JSON.parse(l) as ReplayEvent)
    expect(events[0].type).toBe('sandbox.created')
    expect(events[1].type).toBe('sandbox.ready')
    expect(events[2].type).toBe('exec.started')
    expect(events[3].type).toBe('exec.output')
    expect(events[4].type).toBe('exec.completed')
    expect(events[5].type).toBe('sandbox.stopped')

    // Verify monotonic sequence
    for (let i = 1; i < events.length; i++) {
      expect(events[i].seq).toBeGreaterThan(events[i - 1].seq)
    }

    // Verify per-exec output file
    const execContent = await run(
      objectStorage.getObject(`${TEST_ORG}/${TEST_SANDBOX}/exec/ex_abc.log`),
    )
    expect(execContent).not.toBeNull()
    const execEntry = JSON.parse(execContent!.trim()) as ExecOutputEntry
    expect(execEntry.stream).toBe('stdout')
    expect(execEntry.data).toBe('PASS src/index.test.ts\n')
  })

  test('JSONL format matches spec — each line is valid JSON', async () => {
    const { recorder, objectStorage } = createTestRecorder()

    await run(
      recorder.record({
        sandboxId: TEST_SANDBOX,
        orgId: TEST_ORG,
        event: sandboxCreated({ image: 'img', profile: 'small', env: null, forked_from: null }),
      }),
    )
    await run(recorder.flush({ sandboxId: TEST_SANDBOX, orgId: TEST_ORG }))

    const content = await run(objectStorage.getObject(`${TEST_ORG}/${TEST_SANDBOX}/events.jsonl`))
    const lines = content!.trim().split('\n')

    for (const line of lines) {
      const parsed = JSON.parse(line) as ReplayEvent
      expect(parsed).toHaveProperty('ts')
      expect(parsed).toHaveProperty('seq')
      expect(parsed).toHaveProperty('type')
      expect(parsed).toHaveProperty('data')
    }
  })
})
