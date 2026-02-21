import { describe, test, expect } from 'bun:test'
import { ExecStream, parseSSE } from './stream.js'
import type { ExecStreamEvent } from '@sandchest/contract'

function sseResponse(events: Array<{ data: string }>): Response {
  const text = events.map((e) => `data: ${e.data}\n\n`).join('')
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('parseSSE', () => {
  test('parses SSE data lines into typed objects', async () => {
    const response = sseResponse([
      { data: '{"seq":1,"t":"stdout","data":"hello\\n"}' },
      { data: '{"seq":2,"t":"exit","code":0,"duration_ms":10,"resource_usage":{"cpu_ms":5,"peak_memory_bytes":256}}' },
    ])

    const events: ExecStreamEvent[] = []
    for await (const event of parseSSE<ExecStreamEvent>(response)) {
      events.push(event)
    }

    expect(events).toHaveLength(2)
    expect(events[0]!.t).toBe('stdout')
    expect(events[1]!.t).toBe('exit')
  })

  test('skips empty data lines', async () => {
    const text = 'data: \n\ndata: {"seq":1,"t":"stdout","data":"ok"}\n\n'
    const response = new Response(text, { status: 200 })

    const events: unknown[] = []
    for await (const event of parseSSE(response)) {
      events.push(event)
    }

    expect(events).toHaveLength(1)
  })

  test('handles chunked delivery across event boundaries', async () => {
    const fullText = 'data: {"seq":1,"t":"stdout","data":"a"}\n\ndata: {"seq":2,"t":"stdout","data":"b"}\n\n'
    const encoder = new TextEncoder()
    const bytes = encoder.encode(fullText)
    const chunks: Uint8Array[] = []
    for (let i = 0; i < bytes.length; i += 5) {
      chunks.push(bytes.slice(i, i + 5))
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk)
        }
        controller.close()
      },
    })

    const response = new Response(stream, { status: 200 })
    const events: ExecStreamEvent[] = []
    for await (const event of parseSSE<ExecStreamEvent>(response)) {
      events.push(event)
    }

    expect(events).toHaveLength(2)
  })
})

describe('ExecStream', () => {
  function makeGenerator(events: ExecStreamEvent[]): AsyncGenerator<ExecStreamEvent> {
    return (async function* () {
      for (const event of events) {
        yield event
      }
    })()
  }

  test('exposes execId', () => {
    const stream = new ExecStream('ex_123', makeGenerator([]))
    expect(stream.execId).toBe('ex_123')
  })

  test('is async iterable', async () => {
    const events: ExecStreamEvent[] = [
      { seq: 1, t: 'stdout', data: 'hello\n' },
      { seq: 2, t: 'exit', code: 0, duration_ms: 10, resource_usage: { cpu_ms: 5, peak_memory_bytes: 256 } },
    ]

    const stream = new ExecStream('ex_123', makeGenerator(events))
    const collected: ExecStreamEvent[] = []
    for await (const event of stream) {
      collected.push(event)
    }

    expect(collected).toHaveLength(2)
    expect(collected[0]!.t).toBe('stdout')
    expect(collected[1]!.t).toBe('exit')
  })

  test('collect() returns aggregated ExecResult', async () => {
    const events: ExecStreamEvent[] = [
      { seq: 1, t: 'stdout', data: 'line1\n' },
      { seq: 2, t: 'stderr', data: 'warn\n' },
      { seq: 3, t: 'stdout', data: 'line2\n' },
      { seq: 4, t: 'exit', code: 0, duration_ms: 50, resource_usage: { cpu_ms: 10, peak_memory_bytes: 1024 } },
    ]

    const stream = new ExecStream('ex_456', makeGenerator(events))
    const result = await stream.collect()

    expect(result.execId).toBe('ex_456')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('line1\nline2\n')
    expect(result.stderr).toBe('warn\n')
    expect(result.durationMs).toBe(50)
  })

  test('collect() handles stream with no output', async () => {
    const events: ExecStreamEvent[] = [
      { seq: 1, t: 'exit', code: 1, duration_ms: 5, resource_usage: { cpu_ms: 1, peak_memory_bytes: 128 } },
    ]

    const stream = new ExecStream('ex_789', makeGenerator(events))
    const result = await stream.collect()

    expect(result.execId).toBe('ex_789')
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(result.durationMs).toBe(5)
  })
})
