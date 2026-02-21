import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'
import { replayCommand } from './replay.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const sandboxResponse = {
  sandbox_id: 'sb_replay',
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
  replay_url: 'https://replay.sandchest.com/sb_replay',
}

describe('replay command', () => {
  let tempDir: string
  const originalXdg = process.env['XDG_CONFIG_HOME']
  const originalApiKey = process.env['SANDCHEST_API_KEY']
  let originalFetch: typeof globalThis.fetch
  let logSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-replay-test-'))
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

  test('prints replay URL', async () => {
    globalThis.fetch = mock(async () => jsonResponse(sandboxResponse)) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(replayCommand())
    await program.parseAsync(['node', 'test', 'replay', 'sb_replay'])

    expect(logSpy).toHaveBeenCalledWith('https://replay.sandchest.com/sb_replay')
  })

  test('outputs JSON with --json flag', async () => {
    globalThis.fetch = mock(async () => jsonResponse(sandboxResponse)) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(replayCommand())
    await program.parseAsync(['node', 'test', 'replay', '--json', 'sb_replay'])

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
    expect(parsed.sandbox_id).toBe('sb_replay')
    expect(parsed.replay_url).toBe('https://replay.sandchest.com/sb_replay')
  })
})
