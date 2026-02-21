import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'
import { lsCommand } from './ls.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const listResponse = {
  sandboxes: [
    {
      sandbox_id: 'sb_abc',
      status: 'running',
      image: 'ubuntu-22.04',
      profile: 'small',
      forked_from: null,
      created_at: new Date().toISOString(),
      replay_url: 'https://replay.sandchest.com/sb_abc',
    },
    {
      sandbox_id: 'sb_def',
      status: 'stopped',
      image: 'node:20',
      profile: 'medium',
      forked_from: 'sb_abc',
      created_at: new Date().toISOString(),
      replay_url: 'https://replay.sandchest.com/sb_def',
    },
  ],
  next_cursor: null,
}

describe('ls command', () => {
  let tempDir: string
  const originalXdg = process.env['XDG_CONFIG_HOME']
  const originalApiKey = process.env['SANDCHEST_API_KEY']
  let originalFetch: typeof globalThis.fetch
  let logSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-ls-test-'))
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

  test('lists sandboxes in table format', async () => {
    globalThis.fetch = mock(async () => jsonResponse(listResponse)) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(lsCommand())
    await program.parseAsync(['node', 'test', 'ls'])

    // Header
    expect(logSpy.mock.calls[0]![0]).toContain('ID')
    expect(logSpy.mock.calls[0]![0]).toContain('STATUS')
    // Rows
    const allOutput = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(allOutput).toContain('sb_abc')
    expect(allOutput).toContain('sb_def')
    expect(allOutput).toContain('ubuntu-22.04')
    expect(allOutput).toContain('node:20')
  })

  test('outputs JSON with --json flag', async () => {
    globalThis.fetch = mock(async () => jsonResponse(listResponse)) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(lsCommand())
    await program.parseAsync(['node', 'test', 'ls', '--json'])

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
    expect(parsed[0].sandbox_id).toBe('sb_abc')
  })

  test('shows message when no sandboxes found', async () => {
    globalThis.fetch = mock(async () =>
      jsonResponse({ sandboxes: [], next_cursor: null }),
    ) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(lsCommand())
    await program.parseAsync(['node', 'test', 'ls'])

    expect(logSpy).toHaveBeenCalledWith('No sandboxes found.')
  })

  test('passes status filter as query parameter', async () => {
    let capturedUrl = ''
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      capturedUrl = String(url)
      return jsonResponse({ sandboxes: [], next_cursor: null })
    }) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(lsCommand())
    await program.parseAsync(['node', 'test', 'ls', '--status', 'running'])

    expect(capturedUrl).toContain('status=running')
  })
})
