import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'
import { sshCommand } from './ssh.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const sandboxResponse = {
  sandbox_id: 'sb_ssh',
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
  replay_url: 'https://replay.sandchest.com/sb_ssh',
}

const sessionResponse = {
  session_id: 'sess_abc',
  status: 'running',
}

const execResponse = {
  exec_id: 'ex_sess1',
  status: 'done',
  exit_code: 0,
  stdout: '/home/user\n',
  stderr: '',
  duration_ms: 5,
  resource_usage: { cpu_ms: 2, memory_peak_bytes: 512 },
}

describe('ssh command', () => {
  let tempDir: string
  const originalXdg = process.env['XDG_CONFIG_HOME']
  const originalApiKey = process.env['SANDCHEST_API_KEY']
  let originalFetch: typeof globalThis.fetch
  let logSpy: ReturnType<typeof spyOn>
  let stderrSpy: ReturnType<typeof spyOn>
  let stdoutWriteSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-ssh-test-'))
    process.env['XDG_CONFIG_HOME'] = tempDir
    process.env['SANDCHEST_API_KEY'] = 'sk_test_key'
    process.env['NO_COLOR'] = '1'
    originalFetch = globalThis.fetch
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
    stderrSpy = spyOn(console, 'error').mockImplementation(() => {})
    stdoutWriteSpy = spyOn(process.stdout, 'write').mockImplementation(() => true)
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
    stderrSpy.mockRestore()
    stdoutWriteSpy.mockRestore()
  })

  test('creates session with correct shell option', async () => {
    let sessionCreateBody: string | undefined
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.includes('/sessions') && init?.method === 'POST') {
        sessionCreateBody = init.body as string
        return jsonResponse(sessionResponse, 201)
      }
      if (urlStr.includes('/sessions/') && urlStr.includes('/exec')) {
        return jsonResponse(execResponse)
      }
      if (urlStr.includes('/sessions/') && init?.method === 'DELETE') {
        return jsonResponse({ ok: true })
      }
      return jsonResponse(sandboxResponse)
    }) as unknown as typeof fetch

    // Simulate stdin with 'exit' to end the session
    const { Readable } = await import('node:stream')
    const mockStdin = new Readable({
      read() {
        this.push('exit\n')
        this.push(null)
      },
    })

    const originalStdin = process.stdin
    Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true })

    try {
      const program = new Command()
      program.addCommand(sshCommand())
      await program.parseAsync(['node', 'test', 'ssh', '--shell', '/bin/zsh', 'sb_ssh'])

      expect(sessionCreateBody).toBeDefined()
      const body = JSON.parse(sessionCreateBody!)
      expect(body.shell).toBe('/bin/zsh')
    } finally {
      Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true })
    }
  })

  test('passes environment variables to session', async () => {
    let sessionCreateBody: string | undefined
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.includes('/sessions') && init?.method === 'POST') {
        sessionCreateBody = init.body as string
        return jsonResponse(sessionResponse, 201)
      }
      if (urlStr.includes('/sessions/') && init?.method === 'DELETE') {
        return jsonResponse({ ok: true })
      }
      return jsonResponse(sandboxResponse)
    }) as unknown as typeof fetch

    const { Readable } = await import('node:stream')
    const mockStdin = new Readable({
      read() {
        this.push('exit\n')
        this.push(null)
      },
    })

    const originalStdin = process.stdin
    Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true })

    try {
      const program = new Command()
      program.addCommand(sshCommand())
      await program.parseAsync([
        'node', 'test', 'ssh', '-e', 'FOO=bar', '-e', 'BAZ=qux', 'sb_ssh',
      ])

      expect(sessionCreateBody).toBeDefined()
      const body = JSON.parse(sessionCreateBody!)
      expect(body.env).toEqual({ FOO: 'bar', BAZ: 'qux' })
    } finally {
      Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true })
    }
  })
})
