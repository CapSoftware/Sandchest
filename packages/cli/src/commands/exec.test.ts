import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'
import { execCommand } from './exec.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const sandboxResponse = {
  sandbox_id: 'sb_exec',
  status: 'running',
  image: 'ubuntu-22.04',
  profile: 'small',
  env: {},
  forked_from: null,
  fork_count: 0,
  created_at: '2024-01-01T00:00:00Z',
  started_at: '2024-01-01T00:00:01Z',
  ended_at: null,
  failure_reason: null,
  replay_url: 'https://replay.sandchest.com/sb_exec',
}

const execResponse = {
  exec_id: 'ex_123',
  status: 'done',
  exit_code: 0,
  stdout: 'hello world\n',
  stderr: '',
  duration_ms: 42,
  resource_usage: { cpu_ms: 10, memory_peak_bytes: 1024 },
}

describe('exec command', () => {
  let tempDir: string
  const originalXdg = process.env['XDG_CONFIG_HOME']
  const originalApiKey = process.env['SANDCHEST_API_KEY']
  let originalFetch: typeof globalThis.fetch
  let logSpy: ReturnType<typeof spyOn>
  let exitSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-exec-test-'))
    process.env['XDG_CONFIG_HOME'] = tempDir
    process.env['SANDCHEST_API_KEY'] = 'sk_test_key'
    process.env['NO_COLOR'] = '1'
    originalFetch = globalThis.fetch
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
    exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never)
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
    exitSpy.mockRestore()
  })

  test('outputs JSON with --json flag', async () => {
    let callCount = 0
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      callCount++
      const urlStr = String(url)
      if (urlStr.includes('/exec') && callCount === 2) {
        return jsonResponse(execResponse)
      }
      return jsonResponse(sandboxResponse)
    }) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(execCommand())
    await program.parseAsync(['node', 'test', 'exec', '--json', 'sb_exec', 'echo hello'])

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
    expect(parsed.exec_id).toBe('ex_123')
    expect(parsed.exit_code).toBe(0)
    expect(parsed.stdout).toBe('hello world\n')
  })

  test('exits with code 1 on non-zero exit code', async () => {
    let callCount = 0
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      callCount++
      const urlStr = String(url)
      if (urlStr.includes('/exec') && callCount === 2) {
        return jsonResponse({ ...execResponse, exit_code: 1, stderr: 'error\n' })
      }
      return jsonResponse(sandboxResponse)
    }) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(execCommand())
    await program.parseAsync(['node', 'test', 'exec', '--json', 'sb_exec', 'false'])

    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
