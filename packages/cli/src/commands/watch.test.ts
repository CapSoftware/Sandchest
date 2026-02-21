import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'
import { watchCommand } from './watch.js'

function sseResponse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('watch command', () => {
  let tempDir: string
  const originalXdg = process.env['XDG_CONFIG_HOME']
  const originalApiKey = process.env['SANDCHEST_API_KEY']
  let originalFetch: typeof globalThis.fetch
  let logSpy: ReturnType<typeof spyOn>
  let stdoutWriteSpy: ReturnType<typeof spyOn>
  let stderrWriteSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-watch-test-'))
    process.env['XDG_CONFIG_HOME'] = tempDir
    process.env['SANDCHEST_API_KEY'] = 'sk_test_key'
    process.env['NO_COLOR'] = '1'
    originalFetch = globalThis.fetch
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
    stdoutWriteSpy = spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrWriteSpy = spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    if (originalXdg !== undefined) {
      process.env['XDG_CONFIG_HOME'] = originalXdg
    } else {
      delete process.env['XDG_CONFIG_HOME']
    }
    if (originalApiKey !== undefined) {
      process.env['SANDCHEST_API_KEY'] = originalApiKey
    } else {
      delete process.env['SANDCHEST_API_KEY']
    }
    delete process.env['NO_COLOR']
    globalThis.fetch = originalFetch
    logSpy.mockRestore()
    stdoutWriteSpy.mockRestore()
    stderrWriteSpy.mockRestore()
  })

  test('streams stdout and stderr events', async () => {
    const events = [
      { seq: 1, t: 'stdout', data: 'hello ' },
      { seq: 2, t: 'stderr', data: 'warning\n' },
      { seq: 3, t: 'stdout', data: 'world\n' },
      { seq: 4, t: 'exit', code: 0, duration_ms: 100, resource_usage: { cpu_ms: 50, peak_memory_bytes: 2048 } },
    ]
    globalThis.fetch = mock(async () => sseResponse(events)) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(watchCommand())
    await program.parseAsync(['node', 'test', 'watch', 'sb_test', 'ex_123'])

    expect(stdoutWriteSpy).toHaveBeenCalledWith('hello ')
    expect(stdoutWriteSpy).toHaveBeenCalledWith('world\n')
    expect(stderrWriteSpy).toHaveBeenCalledWith('warning\n')
  })

  test('outputs JSON events with --json flag', async () => {
    const events = [
      { seq: 1, t: 'stdout', data: 'output\n' },
      { seq: 2, t: 'exit', code: 0, duration_ms: 50, resource_usage: { cpu_ms: 10, peak_memory_bytes: 1024 } },
    ]
    globalThis.fetch = mock(async () => sseResponse(events)) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(watchCommand())
    await program.parseAsync(['node', 'test', 'watch', '--json', 'sb_test', 'ex_123'])

    const jsonCalls = logSpy.mock.calls.filter((call: unknown[]) => {
      try {
        JSON.parse(String(call[0]))
        return true
      } catch {
        return false
      }
    })
    expect(jsonCalls.length).toBe(2)
    const first = JSON.parse(String(jsonCalls[0]![0]))
    expect(first.t).toBe('stdout')
    expect(first.data).toBe('output\n')
  })

  test('exits with non-zero code on failed exec', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const events = [
      { seq: 1, t: 'stdout', data: 'partial output\n' },
      { seq: 2, t: 'exit', code: 1, duration_ms: 200, resource_usage: { cpu_ms: 100, peak_memory_bytes: 4096 } },
    ]
    globalThis.fetch = mock(async () => sseResponse(events)) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(watchCommand())
    await program.parseAsync(['node', 'test', 'watch', 'sb_test', 'ex_fail'])

    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })
})
