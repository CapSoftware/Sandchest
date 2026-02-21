import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'
import { createCommand } from './create.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('create command', () => {
  let tempDir: string
  const originalXdg = process.env['XDG_CONFIG_HOME']
  const originalApiKey = process.env['SANDCHEST_API_KEY']
  let originalFetch: typeof globalThis.fetch
  let logSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-create-test-'))
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

  test('creates sandbox and prints success', async () => {
    let callCount = 0
    globalThis.fetch = mock(async () => {
      callCount++
      if (callCount === 1) {
        return jsonResponse(
          {
            sandbox_id: 'sb_test123',
            status: 'queued',
            queue_position: 1,
            estimated_ready_seconds: 5,
            replay_url: 'https://replay.sandchest.com/sb_test123',
            created_at: '2024-01-01T00:00:00Z',
          },
          201,
        )
      }
      return jsonResponse({
        sandbox_id: 'sb_test123',
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
        replay_url: 'https://replay.sandchest.com/sb_test123',
      })
    }) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(createCommand())
    await program.parseAsync(['node', 'test', 'create'])

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('sb_test123'))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('created'))
  })

  test('outputs JSON with --json flag', async () => {
    let callCount = 0
    globalThis.fetch = mock(async () => {
      callCount++
      if (callCount === 1) {
        return jsonResponse(
          {
            sandbox_id: 'sb_json',
            status: 'queued',
            queue_position: 0,
            estimated_ready_seconds: 0,
            replay_url: 'https://replay.sandchest.com/sb_json',
            created_at: '2024-01-01T00:00:00Z',
          },
          201,
        )
      }
      return jsonResponse({
        sandbox_id: 'sb_json',
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
        replay_url: 'https://replay.sandchest.com/sb_json',
      })
    }) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(createCommand())
    await program.parseAsync(['node', 'test', 'create', '--json'])

    const jsonOutput = logSpy.mock.calls.find((call: unknown[]) => {
      try {
        JSON.parse(String(call[0]))
        return true
      } catch {
        return false
      }
    })
    expect(jsonOutput).toBeDefined()
    const parsed = JSON.parse(String(jsonOutput![0]))
    expect(parsed.sandbox_id).toBe('sb_json')
    expect(parsed.status).toBe('running')
  })

  test('passes options to create call', async () => {
    let capturedBody: string | undefined
    let callCount = 0
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      callCount++
      if (callCount === 1) {
        capturedBody = init?.body as string
        return jsonResponse(
          {
            sandbox_id: 'sb_opts',
            status: 'queued',
            queue_position: 0,
            estimated_ready_seconds: 0,
            replay_url: 'https://replay.sandchest.com/sb_opts',
            created_at: '2024-01-01T00:00:00Z',
          },
          201,
        )
      }
      return jsonResponse({
        sandbox_id: 'sb_opts',
        status: 'running',
        image: 'node:20',
        profile: 'medium',
        env: { NODE_ENV: 'production' },
        forked_from: null,
        fork_count: 0,
        created_at: '2024-01-01T00:00:00Z',
        started_at: null,
        ended_at: null,
        failure_reason: null,
        replay_url: 'https://replay.sandchest.com/sb_opts',
      })
    }) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(createCommand())
    await program.parseAsync([
      'node',
      'test',
      'create',
      '-i',
      'node:20',
      '-p',
      'medium',
      '-e',
      'NODE_ENV=production',
      '--ttl',
      '3600',
    ])

    expect(capturedBody).toBeDefined()
    const body = JSON.parse(capturedBody!)
    expect(body.image).toBe('node:20')
    expect(body.profile).toBe('medium')
    expect(body.env).toEqual({ NODE_ENV: 'production' })
    expect(body.ttl_seconds).toBe(3600)
  })
})
