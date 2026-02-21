import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'
import { logsCommand } from './logs.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const execsResponse = {
  execs: [
    {
      exec_id: 'ex_001',
      sandbox_id: 'sb_logs',
      session_id: null,
      cmd: 'echo hello',
      status: 'done',
      exit_code: 0,
      duration_ms: 42,
      resource_usage: { cpu_ms: 10, memory_peak_bytes: 1024 },
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
    },
    {
      exec_id: 'ex_002',
      sandbox_id: 'sb_logs',
      session_id: 'sess_1',
      cmd: ['npm', 'test'],
      status: 'failed',
      exit_code: 1,
      duration_ms: 5000,
      resource_usage: { cpu_ms: 2000, memory_peak_bytes: 65536 },
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
    },
  ],
  next_cursor: null,
}

describe('logs command', () => {
  let tempDir: string
  const originalXdg = process.env['XDG_CONFIG_HOME']
  const originalApiKey = process.env['SANDCHEST_API_KEY']
  let originalFetch: typeof globalThis.fetch
  let logSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-logs-test-'))
    process.env['XDG_CONFIG_HOME'] = tempDir
    process.env['SANDCHEST_API_KEY'] = 'sk_test_key'
    process.env['NO_COLOR'] = '1'
    originalFetch = globalThis.fetch
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
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
  })

  test('lists executions in table format', async () => {
    globalThis.fetch = mock(async () => jsonResponse(execsResponse)) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(logsCommand())
    await program.parseAsync(['node', 'test', 'logs', 'sb_logs'])

    const allOutput = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(allOutput).toContain('EXEC ID')
    expect(allOutput).toContain('STATUS')
    expect(allOutput).toContain('ex_001')
    expect(allOutput).toContain('ex_002')
    expect(allOutput).toContain('echo hello')
    expect(allOutput).toContain('npm test')
  })

  test('outputs JSON with --json flag', async () => {
    globalThis.fetch = mock(async () => jsonResponse(execsResponse)) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(logsCommand())
    await program.parseAsync(['node', 'test', 'logs', '--json', 'sb_logs'])

    const jsonCall = logSpy.mock.calls.find((call: unknown[]) => {
      try {
        JSON.parse(String(call[0]))
        return true
      } catch {
        return false
      }
    })
    expect(jsonCall).toBeDefined()
    const parsed = JSON.parse(String(jsonCall![0]))
    expect(parsed).toHaveLength(2)
    expect(parsed[0].exec_id).toBe('ex_001')
    expect(parsed[1].exec_id).toBe('ex_002')
  })

  test('shows message when no executions found', async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ execs: [], next_cursor: null }),
    ) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(logsCommand())
    await program.parseAsync(['node', 'test', 'logs', 'sb_empty'])

    expect(logSpy).toHaveBeenCalledWith('No executions found.')
  })

  test('passes status filter and limit as query parameters', async () => {
    let capturedUrl = ''
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      capturedUrl = String(url)
      return jsonResponse({ execs: [], next_cursor: null })
    }) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(logsCommand())
    await program.parseAsync([
      'node', 'test', 'logs', '--status', 'done', '-n', '5', 'sb_logs',
    ])

    expect(capturedUrl).toContain('status=done')
    expect(capturedUrl).toContain('limit=5')
  })
})
