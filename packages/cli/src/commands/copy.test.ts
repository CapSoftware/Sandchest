import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { copyCommand, extractSandboxTarballToNewDirectory } from './copy.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const sandboxResponse = {
  sandbox_id: 'sb_copy',
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
  replay_url: 'https://replay.sandchest.com/sb_copy',
}

describe('copy command', () => {
  let tempDir: string
  let originalCwd: string
  const originalXdg = process.env['XDG_CONFIG_HOME']
  const originalApiKey = process.env['SANDCHEST_API_KEY']
  let originalFetch: typeof globalThis.fetch
  let logSpy: ReturnType<typeof spyOn>
  let errorSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-copy-test-'))
    originalCwd = process.cwd()
    process.chdir(tempDir)
    process.env['XDG_CONFIG_HOME'] = tempDir
    process.env['SANDCHEST_API_KEY'] = 'sk_test_key'
    process.env['NO_COLOR'] = '1'
    originalFetch = globalThis.fetch
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = spyOn(console, 'error').mockImplementation(() => {})
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
    errorSpy.mockRestore()
  })

  test('copy up creates a git-aware archive and uploads it via uploadDir', async () => {
    const repoDir = join(tempDir, 'repo')
    execFileSync('git', ['init', repoDir], { stdio: 'pipe' })
    writeFileSync(join(repoDir, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(repoDir, 'tracked.txt'), 'tracked')
    writeFileSync(join(repoDir, 'untracked.txt'), 'untracked')
    writeFileSync(join(repoDir, 'ignored.txt'), 'ignored')
    execFileSync('git', ['-C', repoDir, 'add', '.gitignore', 'tracked.txt'], { stdio: 'pipe' })

    let uploadedTarball: Uint8Array | undefined
    let execCount = 0
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.endsWith('/v1/sandboxes/sb_copy')) {
        return jsonResponse(sandboxResponse)
      }
      if (init?.method === 'PUT' && urlStr.includes('/files')) {
        uploadedTarball = init.body as Uint8Array
        return new Response(null, { status: 204 })
      }
      if (init?.method === 'POST' && urlStr.endsWith('/exec')) {
        execCount++
        return jsonResponse({
          exec_id: `ex_${execCount}`,
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 5,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        })
      }
      throw new Error(`Unexpected request: ${urlStr}`)
    }) as unknown as typeof fetch

    const program = new Command()
    program.exitOverride()
    program.addCommand(copyCommand())
    await program.parseAsync(['node', 'test', 'copy', 'up', 'sb_copy', repoDir, '/work/repo'])

    expect(uploadedTarball).toBeDefined()
    const inspectDir = join(tempDir, 'inspect')
    mkdirSync(inspectDir)
    const archivePath = join(inspectDir, 'upload.tar.gz')
    writeFileSync(archivePath, uploadedTarball!)
    execFileSync('tar', ['xzf', archivePath, '-C', inspectDir], { stdio: 'pipe' })

    expect(readFileSync(join(inspectDir, 'tracked.txt'), 'utf-8')).toBe('tracked')
    expect(readFileSync(join(inspectDir, 'untracked.txt'), 'utf-8')).toBe('untracked')
    expect(existsSync(join(inspectDir, 'ignored.txt'))).toBe(false)
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('git-ls-files'))
  })

  test('copy down extracts a sandbox directory into a new local path and supports json output', async () => {
    const sourceDir = join(tempDir, 'source')
    mkdirSync(sourceDir)
    writeFileSync(join(sourceDir, 'result.txt'), 'payload')
    const archivePath = join(tempDir, 'download.tar.gz')
    execFileSync('tar', ['czf', archivePath, '-C', sourceDir, '.'], { stdio: 'pipe' })
    const tarball = new Uint8Array(readFileSync(archivePath))

    let execCount = 0
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url)
      if (urlStr.endsWith('/v1/sandboxes/sb_copy')) {
        return jsonResponse(sandboxResponse)
      }
      if (init?.method === 'POST' && urlStr.endsWith('/exec')) {
        execCount++
        return jsonResponse({
          exec_id: `ex_${execCount}`,
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 5,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        })
      }
      if (init?.method === 'GET' && urlStr.includes('/files')) {
        return new Response(tarball, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      }
      throw new Error(`Unexpected request: ${urlStr}`)
    }) as unknown as typeof fetch

    const destination = join(tempDir, 'out')
    const program = new Command()
    program.exitOverride()
    program.addCommand(copyCommand())
    await program.parseAsync([
      'node',
      'test',
      'copy',
      'down',
      '--json',
      'sb_copy',
      '/work/result',
      destination,
    ])

    expect(readFileSync(join(destination, 'result.txt'), 'utf-8')).toBe('payload')
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
    expect(parsed.ok).toBe(true)
    expect(parsed.remote_path).toBe('/work/result')
    expect(parsed.local_path).toBe(destination)
  })

  test('copy down helper rejects an existing destination before writing files', async () => {
    const destination = join(tempDir, 'existing')
    mkdirSync(destination)
    const tarball = new Uint8Array([31, 139, 8, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(() => extractSandboxTarballToNewDirectory(tarball, destination)).toThrow(
      'Destination already exists',
    )
  })

  test('copy down helper extracts nested directories from a validated archive', async () => {
    const sourceDir = join(tempDir, 'nested-source')
    mkdirSync(join(sourceDir, 'subdir'), { recursive: true })
    writeFileSync(join(sourceDir, 'subdir', 'result.txt'), 'payload')
    const archivePath = join(tempDir, 'nested.tar.gz')
    execFileSync('tar', ['czf', archivePath, '-C', sourceDir, '.'], { stdio: 'pipe' })

    const destination = join(tempDir, 'nested-out')
    extractSandboxTarballToNewDirectory(new Uint8Array(readFileSync(archivePath)), destination)

    expect(readFileSync(join(destination, 'subdir', 'result.txt'), 'utf-8')).toBe('payload')
  })

  test('copy up skips git-tracked symbolic links with a warning', async () => {
    const repoDir = join(tempDir, 'repo-links')
    execFileSync('git', ['init', repoDir], { stdio: 'pipe' })
    writeFileSync(join(repoDir, 'tracked.txt'), 'tracked')
    symlinkSync('tracked.txt', join(repoDir, 'linked.txt'))
    execFileSync('git', ['-C', repoDir, 'add', 'tracked.txt', 'linked.txt'], { stdio: 'pipe' })

    // Symlinks are now skipped with a warning instead of rejecting.
    // The archive should still be created, containing only the regular file.
    const archivePath = join(tempDir, 'links-archive.tar.gz')
    const { createLocalArchive } = await import('./copy.js')
    const method = createLocalArchive(repoDir, archivePath, {})
    expect(method).toBe('git-ls-files')

    // The archive should exist and contain tracked.txt but NOT linked.txt
    const { existsSync } = await import('node:fs')
    expect(existsSync(archivePath)).toBe(true)
  })
})
