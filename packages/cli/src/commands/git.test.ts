import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'
import { gitCommand } from './git.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const sandboxResponse = {
  sandbox_id: 'sb_git',
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
  replay_url: 'https://replay.sandchest.com/sb_git',
}

const cloneResponse = {
  exec_id: 'ex_clone123',
  status: 'done',
  exit_code: 0,
  stdout: 'cloned\n',
  stderr: '',
  duration_ms: 321,
  resource_usage: { cpu_ms: 10, memory_peak_bytes: 1024 },
}

describe('git command', () => {
  let tempDir: string
  const originalXdg = process.env['XDG_CONFIG_HOME']
  const originalApiKey = process.env['SANDCHEST_API_KEY']
  let originalFetch: typeof globalThis.fetch
  let logSpy: ReturnType<typeof spyOn>
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-git-test-'))
    process.env['XDG_CONFIG_HOME'] = tempDir
    process.env['SANDCHEST_API_KEY'] = 'sk_test_key'
    process.env['NO_COLOR'] = '1'
    originalFetch = globalThis.fetch
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
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
    errorSpy.mockRestore()
  })

  test('git clone clones a repository and prints success', async () => {
    let execBody = ''
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        execBody = String(init.body)
        return jsonResponse(cloneResponse)
      }
      return jsonResponse(sandboxResponse)
    }) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(gitCommand())
    await program.parseAsync([
      'node',
      'test',
      'git',
      'clone',
      'sb_git',
      'https://github.com/org/repo.git',
      '/work/repo',
    ])

    const body = JSON.parse(execBody)
    expect(body.cmd).toEqual([
      'git',
      'clone',
      '--single-branch',
      '--',
      'https://github.com/org/repo.git',
      '/work/repo',
    ])
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Cloned https://github.com/org/repo.git'))
  })

  test('git clone forwards options and outputs JSON', async () => {
    let execBody = ''
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.includes('/exec') && init?.method === 'POST') {
        execBody = String(init.body)
        return jsonResponse(cloneResponse)
      }
      return jsonResponse(sandboxResponse)
    }) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(gitCommand())
    await program.parseAsync([
      'node',
      'test',
      'git',
      'clone',
      '--json',
      '--branch',
      'main',
      '--depth',
      '1',
      '--all-branches',
      '--timeout',
      '45',
      '-e',
      'GIT_TRACE=1',
      'sb_git',
      'https://github.com/org/repo.git',
    ])

    const body = JSON.parse(execBody)
    expect(body.cmd).toEqual([
      'git',
      'clone',
      '--branch',
      'main',
      '--depth',
      '1',
      '--',
      'https://github.com/org/repo.git',
      '/work',
    ])
    expect(body.timeout_seconds).toBe(45)
    expect(body.env).toEqual({
      GIT_TERMINAL_PROMPT: '0',
      GIT_TRACE: '1',
    })

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
    expect(parsed.sandbox_id).toBe('sb_git')
    expect(parsed.url).toBe('https://github.com/org/repo.git')
    expect(parsed.dest).toBe('/work')
    expect(parsed.exec_id).toBe('ex_clone123')
    expect(parsed.duration_ms).toBe(321)
  })

  test('git clone rejects non-https URLs unless explicitly allowed', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    try {
      const program = new Command()
      program.addCommand(gitCommand())

      await expect(
        program.parseAsync([
          'node',
          'test',
          'git',
          'clone',
          'sb_git',
          'git@github.com:org/repo.git',
        ]),
      ).rejects.toThrow('exit:2')
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Only HTTPS URLs are allowed by default'))
    } finally {
      exitSpy.mockRestore()
    }
  })

  test('git clone rejects malformed URLs before making sandbox requests', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    let fetchCalled = false
    globalThis.fetch = mock(async () => {
      fetchCalled = true
      return jsonResponse(sandboxResponse)
    }) as unknown as typeof fetch

    try {
      const program = new Command()
      program.addCommand(gitCommand())

      await expect(
        program.parseAsync([
          'node',
          'test',
          'git',
          'clone',
          'sb_git',
          'https://',
        ]),
      ).rejects.toThrow('exit:2')
      expect(fetchCalled).toBe(false)
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid git URL'))
    } finally {
      exitSpy.mockRestore()
    }
  })
})
