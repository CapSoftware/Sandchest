import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'
import { downloadCommand } from './download.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const sandboxResponse = {
  sandbox_id: 'sb_dl',
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
  replay_url: 'https://replay.sandchest.com/sb_dl',
}

describe('download command', () => {
  let tempDir: string
  let originalCwd: string
  const originalXdg = process.env['XDG_CONFIG_HOME']
  const originalApiKey = process.env['SANDCHEST_API_KEY']
  let originalFetch: typeof globalThis.fetch
  let logSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-download-test-'))
    originalCwd = process.cwd()
    process.chdir(tempDir)
    process.env['XDG_CONFIG_HOME'] = tempDir
    process.env['SANDCHEST_API_KEY'] = 'sk_test_key'
    process.env['NO_COLOR'] = '1'
    originalFetch = globalThis.fetch
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    process.chdir(originalCwd)
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

  test('downloads file to specified local path', async () => {
    const fileContent = 'downloaded content'
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = String(url)
      if (urlStr.includes('/files') && urlStr.includes('path=')) {
        return new Response(fileContent, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      }
      return jsonResponse(sandboxResponse)
    }) as unknown as typeof fetch

    const destPath = join(tempDir, 'output.txt')
    const program = new Command()
    program.addCommand(downloadCommand())
    await program.parseAsync([
      'node', 'test', 'download', 'sb_dl', '/tmp/result.txt', destPath,
    ])

    const written = readFileSync(destPath, 'utf-8')
    expect(written).toBe(fileContent)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Downloaded'))
  })

  test('defaults local path to basename of remote path', async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = String(url)
      if (urlStr.includes('/files') && urlStr.includes('path=')) {
        return new Response('data', {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      }
      return jsonResponse(sandboxResponse)
    }) as unknown as typeof fetch

    const program = new Command()
    program.addCommand(downloadCommand())
    await program.parseAsync(['node', 'test', 'download', 'sb_dl', '/var/log/app.log'])

    const written = readFileSync(join(tempDir, 'app.log'), 'utf-8')
    expect(written).toBe('data')
  })

  test('outputs JSON with --json flag', async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = String(url)
      if (urlStr.includes('/files') && urlStr.includes('path=')) {
        return new Response('abc', {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      }
      return jsonResponse(sandboxResponse)
    }) as unknown as typeof fetch

    const destPath = join(tempDir, 'out.txt')
    const program = new Command()
    program.addCommand(downloadCommand())
    await program.parseAsync([
      'node', 'test', 'download', '--json', 'sb_dl', '/tmp/file.txt', destPath,
    ])

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
    expect(parsed.sandbox_id).toBe('sb_dl')
    expect(parsed.remote_path).toBe('/tmp/file.txt')
    expect(parsed.bytes).toBe(3)
  })
})
