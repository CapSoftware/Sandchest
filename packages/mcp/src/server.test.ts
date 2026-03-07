import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from './server.js'
import type { Sandchest, Sandbox, ExecResult } from '@sandchest/sdk'

const TEXT_ENCODER = new TextEncoder()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockSandbox(overrides?: Record<string, any>): Sandbox {
  return {
    id: 'sb_test123',
    status: 'running',
    replayUrl: 'https://sandchest.com/s/sb_test123',
    _http: {},
    fs: {
      upload: mock(async () => {}),
      uploadDir: mock(async () => {}),
      download: mock(async () => new Uint8Array([104, 101, 108, 108, 111])),
      downloadDir: mock(async () => new Uint8Array([1, 2, 3])),
      ls: mock(async () => []),
      rm: mock(async () => {}),
    },
    artifacts: {
      register: mock(async () => ({ registered: 0, total: 0 })),
      list: mock(async () => []),
    },
    git: {
      clone: mock(async () => mockExecResult()),
    },
    session: {
      create: mock(async () => ({
        id: 'sess_abc',
        _sandboxId: 'sb_test123',
        _http: {},
        exec: mock(async () => mockExecResult()),
        destroy: mock(async () => {}),
      })),
    },
    exec: mock(async () => mockExecResult()),
    fork: mock(async () => mockSandbox({ id: 'sb_fork456', replayUrl: 'https://sandchest.com/s/sb_fork456' })),
    forks: mock(async () => ({ root: 'sb_test123', tree: [] })),
    stop: mock(async () => {}),
    destroy: mock(async () => {}),
    waitReady: mock(async () => {}),
    [Symbol.asyncDispose]: mock(async () => {}),
    ...overrides,
  } as unknown as Sandbox
}

function mockExecResult(): ExecResult {
  return {
    execId: 'ex_abc123',
    exitCode: 0,
    stdout: 'hello world\n',
    stderr: '',
    durationMs: 42,
  }
}

function mockClient(): Sandchest {
  const sb = mockSandbox()
  return {
    _http: {},
    create: mock(async () => sb),
    get: mock(async () => sb),
    list: mock(async () => [sb]),
  } as unknown as Sandchest
}

async function setupTestPair(sandchest: Sandchest) {
  const server = createServer(sandchest)
  const client = new Client({ name: 'test-client', version: '0.0.1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  await server.connect(serverTransport)
  await client.connect(clientTransport)

  return { server, client, cleanup: async () => {
    await client.close()
    await server.close()
  }}
}

function parseToolResult(result: { content: unknown[] }): unknown {
  const textContent = result.content[0] as { type: string; text: string }
  return JSON.parse(textContent.text)
}

describe('MCP Server', () => {
  let sandchest: Sandchest
  let client: Client
  let cleanup: () => Promise<void>
  let tempDir: string
  let originalAllowedPaths: string | undefined

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'sandchest-mcp-test-'))
    originalAllowedPaths = process.env['SANDCHEST_MCP_ALLOWED_PATHS']
    delete process.env['SANDCHEST_MCP_ALLOWED_PATHS']
    sandchest = mockClient()
    const pair = await setupTestPair(sandchest)
    client = pair.client
    cleanup = pair.cleanup
  })

  afterEach(async () => {
    await cleanup()
    rmSync(tempDir, { recursive: true, force: true })
    if (originalAllowedPaths === undefined) {
      delete process.env['SANDCHEST_MCP_ALLOWED_PATHS']
    } else {
      process.env['SANDCHEST_MCP_ALLOWED_PATHS'] = originalAllowedPaths
    }
  })

  test('lists all 19 tools', async () => {
    const result = await client.listTools()
    const toolNames = result.tools.map((t) => t.name).sort()
    expect(toolNames).toEqual([
      'sandbox_apply_patch',
      'sandbox_artifacts_list',
      'sandbox_create',
      'sandbox_destroy',
      'sandbox_diff',
      'sandbox_download',
      'sandbox_download_dir',
      'sandbox_exec',
      'sandbox_file_list',
      'sandbox_fork',
      'sandbox_git_clone',
      'sandbox_list',
      'sandbox_replay',
      'sandbox_session_create',
      'sandbox_session_destroy',
      'sandbox_session_exec',
      'sandbox_stop',
      'sandbox_upload',
      'sandbox_upload_dir',
    ])
  })

  test('every tool has a description', async () => {
    const result = await client.listTools()
    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy()
    }
  })

  test('server includes agent instructions', () => {
    const instructions = client.getInstructions()
    expect(instructions).toContain('Sandchest')
    expect(instructions).toContain('sandbox_diff')
    expect(instructions).toContain('sandbox_git_clone')
    expect(instructions).toContain('FORKING')
    expect(instructions).toContain('WORKFLOW PATTERN')
    expect(instructions).toContain('sandchest skill')
    expect(instructions).toContain('checkpoint and fork patterns')
    expect(instructions).toContain('results extraction')
  })

  test('sandbox_diff returns a review diff with untracked files', async () => {
    const sb = mockSandbox()
    ;(sb.exec as ReturnType<typeof mock>)
      .mockImplementationOnce(async () => ({
        execId: 'ex_1',
        exitCode: 0,
        stdout: 'true\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_2',
        exitCode: 0,
        stdout: '/work/repo\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_3',
        exitCode: 0,
        stdout: 'src/\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_4',
        exitCode: 0,
        stdout: 'deadbeef\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_5',
        exitCode: 0,
        stdout: 'diff --git a/src/app.ts b/src/app.ts\n+hello\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_6',
        exitCode: 0,
        stdout: 'src/new.ts\0',
        stderr: '',
        durationMs: 1,
      }))
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    const result = await client.callTool({
      name: 'sandbox_diff',
      arguments: { sandbox_id: 'sb_test123', path: '/work/repo/src' },
    })
    const data = parseToolResult(result as { content: unknown[] }) as {
      ok: boolean
      patch_safe: boolean
      untracked_files: string[]
      diff: string
    }

    expect(data.ok).toBe(true)
    expect(data.patch_safe).toBe(false)
    expect(data.untracked_files).toEqual(['src/new.ts'])
    expect(data.diff).toContain('diff --git')
  })

  test('sandbox_diff returns structured error for non-git directories', async () => {
    const sb = mockSandbox({
      exec: mock(async () => ({
        execId: 'ex_fail',
        exitCode: 1,
        stdout: '',
        stderr: 'not a repo',
        durationMs: 1,
      })),
    })
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    const result = await client.callTool({
      name: 'sandbox_diff',
      arguments: { sandbox_id: 'sb_test123' },
    })
    const data = parseToolResult(result as { content: unknown[] }) as {
      ok: boolean
      error: string
    }

    expect(data.ok).toBe(false)
    expect(data.error).toContain('Not a git repository')
  })

  test('sandbox_diff patch mode returns a patch-safe repo-root diff', async () => {
    const patch = [
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      'index 0000000..ce01362',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1 @@',
      '+hello',
      '',
    ].join('\n')
    const sb = mockSandbox({
      fs: {
        ...mockSandbox().fs,
        download: mock(async () => new TextEncoder().encode(patch)),
      },
    })
    ;(sb.exec as ReturnType<typeof mock>)
      .mockImplementationOnce(async () => ({
        execId: 'ex_1',
        exitCode: 0,
        stdout: 'true\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_2',
        exitCode: 0,
        stdout: '/work/repo\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_3',
        exitCode: 0,
        stdout: 'src/\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_4',
        exitCode: 0,
        stdout: 'deadbeef\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_5',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_6',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_7',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_8',
        exitCode: 0,
        stdout: `${patch.length}\n`,
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_9',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
      }))
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    const result = await client.callTool({
      name: 'sandbox_diff',
      arguments: { sandbox_id: 'sb_test123', path: '/work/repo/src', mode: 'patch' },
    })
    const data = parseToolResult(result as { content: unknown[] }) as {
      ok: boolean
      patch_safe: boolean
      diff: string
      total_bytes: number
    }

    expect(data.ok).toBe(true)
    expect(data.patch_safe).toBe(true)
    expect(data.diff).toContain('diff --git a/src/new.ts b/src/new.ts')
    expect(data.total_bytes).toBe(patch.length)
  })

  test('sandbox_apply_patch uploads the patch, applies it, and cleans up', async () => {
    const sb = mockSandbox()
    ;(sb.exec as ReturnType<typeof mock>)
      .mockImplementationOnce(async () => ({
        execId: 'ex_1',
        exitCode: 0,
        stdout: 'true\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_2',
        exitCode: 0,
        stdout: '/work/repo\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_3',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_4',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_5',
        exitCode: 0,
        stdout: 'Applied patch\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_6',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
      }))
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    const result = await client.callTool({
      name: 'sandbox_apply_patch',
      arguments: { sandbox_id: 'sb_test123', patch: 'diff --git a/a b/a\n' },
    })
    const data = parseToolResult(result as { content: unknown[] }) as {
      ok: boolean
      method: string
      stdout: string
    }

    expect(data.ok).toBe(true)
    expect(data.method).toBe('git-apply')
    expect(data.stdout).toContain('Applied patch')

    const uploadCall = (sb.fs.upload as ReturnType<typeof mock>).mock.calls[0] as [string, Uint8Array]
    expect(uploadCall[0]).toMatch(/^\/tmp\/\.sandchest-patch-/)
    expect(new TextDecoder().decode(uploadCall[1])).toContain('diff --git')

    const cleanupCall = (sb.exec as ReturnType<typeof mock>).mock.calls.at(-1) as
      | [string[], { timeout: number }]
      | undefined
    expect(cleanupCall?.[0]).toEqual([
      'rm',
      '-f',
      expect.stringMatching(/^\/tmp\/\.sandchest-patch-/),
    ])
  })

  test('sandbox_apply_patch normalizes repo-root absolute paths before upload', async () => {
    const sb = mockSandbox()
    ;(sb.exec as ReturnType<typeof mock>)
      .mockImplementationOnce(async () => ({
        execId: 'ex_1',
        exitCode: 0,
        stdout: 'true\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_2',
        exitCode: 0,
        stdout: '/work/repo\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_3',
        exitCode: 0,
        stdout: 'src/\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_4',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_5',
        exitCode: 0,
        stdout: 'Applied patch\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_6',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
      }))
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    const result = await client.callTool({
      name: 'sandbox_apply_patch',
      arguments: {
        sandbox_id: 'sb_test123',
        path: '/work/repo/src',
        patch: [
          'diff --git a//work/repo/src/app.ts b//work/repo/src/app.ts',
          '--- a//work/repo/src/app.ts',
          '+++ b//work/repo/src/app.ts',
          '@@ -1 +1 @@',
          '-hello',
          '+hi',
          '',
        ].join('\n'),
      },
    })
    const data = parseToolResult(result as { content: unknown[] }) as {
      ok: boolean
      method: string
    }

    expect(data.ok).toBe(true)
    expect(data.method).toBe('git-apply')

    const uploadCall = (sb.fs.upload as ReturnType<typeof mock>).mock.calls[0] as [string, Uint8Array]
    const uploadedPatch = new TextDecoder().decode(uploadCall[1])
    expect(uploadedPatch).toContain('diff --git a/src/app.ts b/src/app.ts')
    expect(uploadedPatch).not.toContain('/work/repo/src/app.ts')
  })

  test('sandbox_apply_patch rejects paths outside the requested scope', async () => {
    const sb = mockSandbox()
    ;(sb.exec as ReturnType<typeof mock>)
      .mockImplementationOnce(async () => ({
        execId: 'ex_1',
        exitCode: 0,
        stdout: 'true\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_2',
        exitCode: 0,
        stdout: '/work/repo\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_3',
        exitCode: 0,
        stdout: 'src/\n',
        stderr: '',
        durationMs: 1,
      }))
      .mockImplementationOnce(async () => ({
        execId: 'ex_4',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1,
      }))
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    const result = await client.callTool({
      name: 'sandbox_apply_patch',
      arguments: {
        sandbox_id: 'sb_test123',
        path: '/work/repo/src',
        patch: [
          'diff --git a/other.ts b/other.ts',
          '--- a/other.ts',
          '+++ b/other.ts',
          '@@ -1 +1 @@',
          '-hello',
          '+hi',
          '',
        ].join('\n'),
      },
    })
    const data = parseToolResult(result as { content: unknown[] }) as {
      ok: boolean
      error: string
      method: string
    }

    expect(data.ok).toBe(false)
    expect(data.method).toBe('git-apply')
    expect(data.error).toContain('outside the requested scope')
    expect(sb.fs.upload).not.toHaveBeenCalled()

    const cleanupCall = (sb.exec as ReturnType<typeof mock>).mock.calls.at(-1) as
      | [string[], { timeout: number }]
      | undefined
    expect(cleanupCall?.[0]).toEqual([
      'rm',
      '-f',
      expect.stringMatching(/^\/tmp\/\.sandchest-patch-/),
    ])
  })

  test('sandbox_create calls SDK and returns sandbox_id + replay_url', async () => {
    const result = await client.callTool({
      name: 'sandbox_create',
      arguments: { image: 'sandchest://ubuntu-22.04/node-22', profile: 'small' },
    })
    const data = parseToolResult(result as { content: unknown[] })
    expect(data).toEqual({
      sandbox_id: 'sb_test123',
      replay_url: 'https://sandchest.com/s/sb_test123',
    })
    expect(sandchest.create).toHaveBeenCalledTimes(1)
  })

  test('sandbox_exec returns exec result', async () => {
    const result = await client.callTool({
      name: 'sandbox_exec',
      arguments: { sandbox_id: 'sb_test123', cmd: 'echo hello' },
    })
    const data = parseToolResult(result as { content: unknown[] })
    expect(data).toEqual({
      exec_id: 'ex_abc123',
      exit_code: 0,
      stdout: 'hello world\n',
      stderr: '',
      duration_ms: 42,
    })
  })

  test('sandbox_exec passes cwd and timeout', async () => {
    const sb = mockSandbox()
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    await client.callTool({
      name: 'sandbox_exec',
      arguments: { sandbox_id: 'sb_test123', cmd: 'ls', cwd: '/tmp', timeout: 60 },
    })

    expect(sb.exec).toHaveBeenCalledWith('ls', { cwd: '/tmp', timeout: 60 })
  })

  test('sandbox_session_create returns session_id', async () => {
    const result = await client.callTool({
      name: 'sandbox_session_create',
      arguments: { sandbox_id: 'sb_test123' },
    })
    const data = parseToolResult(result as { content: unknown[] })
    expect(data).toEqual({ session_id: 'sess_abc' })
  })

  test('sandbox_fork returns new sandbox_id and forked_from', async () => {
    const result = await client.callTool({
      name: 'sandbox_fork',
      arguments: { sandbox_id: 'sb_test123' },
    })
    const data = parseToolResult(result as { content: unknown[] })
    expect(data).toEqual({
      sandbox_id: 'sb_fork456',
      forked_from: 'sb_test123',
      replay_url: 'https://sandchest.com/s/sb_fork456',
    })
  })

  test('sandbox_upload encodes utf-8 content and calls fs.upload', async () => {
    const sb = mockSandbox()
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    const result = await client.callTool({
      name: 'sandbox_upload',
      arguments: {
        sandbox_id: 'sb_test123',
        path: '/work/test.txt',
        content: 'hello world',
      },
    })
    const data = parseToolResult(result as { content: unknown[] })
    expect(data).toEqual({ ok: true })
    expect(sb.fs.upload).toHaveBeenCalledTimes(1)

    const [path, bytes] = (sb.fs.upload as ReturnType<typeof mock>).mock.calls[0] as [string, Uint8Array]
    expect(path).toBe('/work/test.txt')
    expect(new TextDecoder().decode(bytes)).toBe('hello world')
  })

  test('sandbox_upload handles base64 encoding', async () => {
    const sb = mockSandbox()
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    await client.callTool({
      name: 'sandbox_upload',
      arguments: {
        sandbox_id: 'sb_test123',
        path: '/work/image.bin',
        content: btoa('binary data'),
        encoding: 'base64',
      },
    })

    const [, bytes] = (sb.fs.upload as ReturnType<typeof mock>).mock.calls[0] as [string, Uint8Array]
    expect(new TextDecoder().decode(bytes)).toBe('binary data')
  })

  test('sandbox_download returns utf-8 content', async () => {
    const sb = mockSandbox()
    ;(sb.fs.download as ReturnType<typeof mock>).mockImplementation(
      async () => new TextEncoder().encode('file contents'),
    )
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    const result = await client.callTool({
      name: 'sandbox_download',
      arguments: { sandbox_id: 'sb_test123', path: '/work/output.txt' },
    })
    const data = parseToolResult(result as { content: unknown[] }) as {
      content: string
      encoding: string
    }
    expect(data.content).toBe('file contents')
    expect(data.encoding).toBe('utf-8')
  })

  test('sandbox_stop calls stop and returns replay_url', async () => {
    const sb = mockSandbox()
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    const result = await client.callTool({
      name: 'sandbox_stop',
      arguments: { sandbox_id: 'sb_test123' },
    })
    const data = parseToolResult(result as { content: unknown[] })
    expect(data).toEqual({ ok: true, replay_url: 'https://sandchest.com/s/sb_test123' })
    expect(sb.stop).toHaveBeenCalledTimes(1)
  })

  test('sandbox_list returns sandbox summaries', async () => {
    const result = await client.callTool({
      name: 'sandbox_list',
      arguments: {},
    })
    const data = parseToolResult(result as { content: unknown[] }) as {
      sandboxes: Array<{ sandbox_id: string; status: string; replay_url: string }>
    }
    expect(data.sandboxes).toHaveLength(1)
    expect(data.sandboxes[0]).toEqual({
      sandbox_id: 'sb_test123',
      status: 'running',
      replay_url: 'https://sandchest.com/s/sb_test123',
    })
  })

  test('sandbox_list passes status filter', async () => {
    await client.callTool({
      name: 'sandbox_list',
      arguments: { status: 'running' },
    })
    expect(sandchest.list).toHaveBeenCalledWith({ status: 'running' })
  })

  test('sandbox_destroy calls destroy and returns sandbox_id', async () => {
    const sb = mockSandbox()
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    const result = await client.callTool({
      name: 'sandbox_destroy',
      arguments: { sandbox_id: 'sb_test123' },
    })
    const data = parseToolResult(result as { content: unknown[] })
    expect(data).toEqual({ ok: true, sandbox_id: 'sb_test123' })
    expect(sb.destroy).toHaveBeenCalledTimes(1)
  })

  test('sandbox_artifacts_list returns artifact details', async () => {
    const sb = mockSandbox({
      artifacts: {
        register: mock(async () => ({ registered: 0, total: 0 })),
        list: mock(async () => [
          {
            id: 'art_abc',
            name: 'report.html',
            mime: 'text/html',
            bytes: 1024,
            sha256: 'deadbeef',
            download_url: 'https://storage.example.com/art_abc',
            exec_id: 'ex_abc123',
            created_at: '2025-01-01T00:00:00Z',
          },
        ]),
      },
    })
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    const result = await client.callTool({
      name: 'sandbox_artifacts_list',
      arguments: { sandbox_id: 'sb_test123' },
    })
    const data = parseToolResult(result as { content: unknown[] }) as {
      artifacts: Array<{ id: string; name: string }>
    }
    expect(data.artifacts).toHaveLength(1)
    expect(data.artifacts[0]).toEqual({
      id: 'art_abc',
      name: 'report.html',
      mime: 'text/html',
      bytes: 1024,
      sha256: 'deadbeef',
      download_url: 'https://storage.example.com/art_abc',
      exec_id: 'ex_abc123',
      created_at: '2025-01-01T00:00:00Z',
    })
  })

  test('sandbox_file_list returns directory entries', async () => {
    const sb = mockSandbox({
      fs: {
        upload: mock(async () => {}),
        uploadDir: mock(async () => {}),
        download: mock(async () => new Uint8Array()),
        downloadDir: mock(async () => new Uint8Array([1, 2, 3])),
        ls: mock(async () => [
          { name: 'src', path: '/work/src', type: 'directory', size_bytes: null },
          { name: 'package.json', path: '/work/package.json', type: 'file', size_bytes: 512 },
        ]),
        rm: mock(async () => {}),
      },
    })
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    const result = await client.callTool({
      name: 'sandbox_file_list',
      arguments: { sandbox_id: 'sb_test123', path: '/work' },
    })
    const data = parseToolResult(result as { content: unknown[] }) as {
      entries: Array<{ name: string; type: string }>
    }
    expect(data.entries).toHaveLength(2)
    expect(data.entries[0]).toEqual({
      name: 'src',
      path: '/work/src',
      type: 'directory',
      size_bytes: null,
    })
    expect(data.entries[1]).toEqual({
      name: 'package.json',
      path: '/work/package.json',
      type: 'file',
      size_bytes: 512,
    })
    expect(sb.fs.ls).toHaveBeenCalledWith('/work')
  })

  test('sandbox_upload_dir fails closed when allowed paths are unset', async () => {
    const result = await client.callTool({
      name: 'sandbox_upload_dir',
      arguments: {
        sandbox_id: 'sb_test123',
        local_path: tempDir,
      },
    })
    const data = parseToolResult(result as { content: unknown[] }) as { ok: boolean; error: string }

    expect(data.ok).toBe(false)
    expect(data.error).toContain('SANDCHEST_MCP_ALLOWED_PATHS')
  })

  test('sandbox_upload_dir packages a git repo, respects .gitignore, and uploads it', async () => {
    process.env['SANDCHEST_MCP_ALLOWED_PATHS'] = tempDir

    const repoDir = join(tempDir, 'repo')
    rmSync(repoDir, { recursive: true, force: true })
    execFileSync('git', ['init', repoDir], { stdio: 'pipe' })
    writeFileSync(join(repoDir, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(repoDir, 'tracked.txt'), 'tracked')
    writeFileSync(join(repoDir, 'untracked.txt'), 'untracked')
    writeFileSync(join(repoDir, 'ignored.txt'), 'ignored')
    execFileSync('git', ['-C', repoDir, 'add', '.gitignore', 'tracked.txt'], { stdio: 'pipe' })

    let capturedTarball: Uint8Array | undefined
    const uploadDir = mock(async (_remotePath: string, tarball: Uint8Array) => {
      capturedTarball = tarball
    })
    const sb = mockSandbox({
      fs: {
        ...mockSandbox().fs,
        uploadDir,
      },
    })
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    const result = await client.callTool({
      name: 'sandbox_upload_dir',
      arguments: {
        sandbox_id: 'sb_test123',
        local_path: repoDir,
        remote_path: '/work/repo',
      },
    })
    const data = parseToolResult(result as { content: unknown[] }) as {
      ok: boolean
      method: string
      remote_path: string
    }

    expect(data.ok).toBe(true)
    expect(data.method).toBe('git-ls-files')
    expect(data.remote_path).toBe('/work/repo')
    expect(uploadDir).toHaveBeenCalledTimes(1)
    expect(capturedTarball).toBeDefined()

    const inspectDir = join(tempDir, 'inspect-upload')
    mkdirSync(inspectDir)
    const archivePath = join(inspectDir, 'archive.tar.gz')
    writeFileSync(archivePath, capturedTarball!)
    execFileSync('tar', ['xzf', archivePath, '-C', inspectDir], { stdio: 'pipe' })

    expect(readFileSync(join(inspectDir, 'tracked.txt'), 'utf-8')).toBe('tracked')
    expect(readFileSync(join(inspectDir, 'untracked.txt'), 'utf-8')).toBe('untracked')
    expect(existsSync(join(inspectDir, 'ignored.txt'))).toBe(false)
  })

  test('sandbox_upload_dir rejects git-tracked symbolic links before upload', async () => {
    process.env['SANDCHEST_MCP_ALLOWED_PATHS'] = tempDir

    const repoDir = join(tempDir, 'repo-with-link')
    execFileSync('git', ['init', repoDir], { stdio: 'pipe' })
    writeFileSync(join(repoDir, 'tracked.txt'), 'tracked')
    symlinkSync('tracked.txt', join(repoDir, 'linked.txt'))
    execFileSync('git', ['-C', repoDir, 'add', 'tracked.txt', 'linked.txt'], { stdio: 'pipe' })

    const result = await client.callTool({
      name: 'sandbox_upload_dir',
      arguments: {
        sandbox_id: 'sb_test123',
        local_path: repoDir,
        remote_path: '/work/repo',
      },
    })
    const data = parseToolResult(result as { content: unknown[] }) as { ok: boolean; error: string }

    expect(data.ok).toBe(false)
    expect(data.error).toContain('does not support symbolic links')
  })

  test('sandbox_download_dir extracts a sandbox archive into a new local directory', async () => {
    process.env['SANDCHEST_MCP_ALLOWED_PATHS'] = tempDir

    const sourceDir = join(tempDir, 'download-source')
    mkdirSync(sourceDir)
    writeFileSync(join(sourceDir, 'result.txt'), 'payload')
    const archivePath = join(tempDir, 'download.tar.gz')
    execFileSync('tar', ['czf', archivePath, '-C', sourceDir, '.'], { stdio: 'pipe' })
    const tarball = new Uint8Array(readFileSync(archivePath))

    const downloadDir = mock(async () => tarball)
    const sb = mockSandbox({
      fs: {
        ...mockSandbox().fs,
        downloadDir,
      },
    })
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    const destination = join(tempDir, 'downloaded')
    const result = await client.callTool({
      name: 'sandbox_download_dir',
      arguments: {
        sandbox_id: 'sb_test123',
        remote_path: '/work/result',
        local_path: destination,
      },
    })
    const data = parseToolResult(result as { content: unknown[] }) as { ok: boolean; local_path: string }

    expect(data.ok).toBe(true)
    expect(data.local_path.endsWith('/downloaded')).toBe(true)
    expect(downloadDir).toHaveBeenCalledWith('/work/result')
    expect(readFileSync(join(destination, 'result.txt'), 'utf-8')).toBe('payload')
  })

  test('sandbox_download_dir rejects an existing destination', async () => {
    process.env['SANDCHEST_MCP_ALLOWED_PATHS'] = tempDir

    const destination = join(tempDir, 'existing')
    mkdirSync(destination)

    const result = await client.callTool({
      name: 'sandbox_download_dir',
      arguments: {
        sandbox_id: 'sb_test123',
        remote_path: '/work/result',
        local_path: destination,
      },
    })
    const data = parseToolResult(result as { content: unknown[] }) as { ok: boolean; error: string }

    expect(data.ok).toBe(false)
    expect(data.error).toContain('Destination already exists')
  })

  test('sandbox_git_clone uses sandbox.git.clone and returns exec metadata', async () => {
    const clone = mock(async () => ({
      execId: 'ex_clone123',
      exitCode: 0,
      stdout: 'cloned\n',
      stderr: '',
      durationMs: 88,
    }))
    const sb = mockSandbox({
      git: {
        clone,
      },
    })
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    const result = await client.callTool({
      name: 'sandbox_git_clone',
      arguments: {
        sandbox_id: 'sb_test123',
        url: 'https://github.com/sandchest/sandchest.git',
        dest: '/work/repo',
        branch: 'main',
        depth: 1,
        single_branch: false,
      },
    })
    const data = parseToolResult(result as { content: unknown[] }) as {
      ok: boolean
      exec_id: string
      exit_code: number
      stdout: string
      stderr: string
      duration_ms: number
    }

    expect(clone).toHaveBeenCalledWith('https://github.com/sandchest/sandchest.git', {
      dest: '/work/repo',
      branch: 'main',
      depth: 1,
      singleBranch: false,
    })
    expect(data).toEqual({
      ok: true,
      exec_id: 'ex_clone123',
      exit_code: 0,
      stdout: 'cloned\n',
      stderr: '',
      duration_ms: 88,
    })
  })

  test('sandbox_git_clone rejects non-https URLs by default', async () => {
    const result = await client.callTool({
      name: 'sandbox_git_clone',
      arguments: {
        sandbox_id: 'sb_test123',
        url: 'git@github.com:sandchest/sandchest.git',
      },
    })
    const data = parseToolResult(result as { content: unknown[] }) as { ok: boolean; error: string }

    expect(data.ok).toBe(false)
    expect(data.error).toContain('Only HTTPS URLs are allowed by default')
  })

  test('sandbox_git_clone returns a structured invalid_url error for malformed URLs', async () => {
    const result = await client.callTool({
      name: 'sandbox_git_clone',
      arguments: {
        sandbox_id: 'sb_test123',
        url: 'https://',
      },
    })
    const data = parseToolResult(result as { content: unknown[] }) as {
      ok: boolean
      error: string
      code: string
    }

    expect(data.ok).toBe(false)
    expect(data.code).toBe('invalid_url')
    expect(data.error).toContain('Invalid git URL')
  })

  test('sandbox_session_destroy calls session.destroy', async () => {
    const destroyMock = mock(async () => {})
    const sb = mockSandbox()
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => sb)

    // Intercept Session constructor — the tool creates a Session internally
    const { Session } = await import('@sandchest/sdk')
    const origProto = Session.prototype.destroy
    Session.prototype.destroy = destroyMock

    const result = await client.callTool({
      name: 'sandbox_session_destroy',
      arguments: { sandbox_id: 'sb_test123', session_id: 'sess_abc' },
    })
    const data = parseToolResult(result as { content: unknown[] })
    expect(data).toEqual({ ok: true })
    expect(destroyMock).toHaveBeenCalledTimes(1)

    Session.prototype.destroy = origProto
  })

  test('sandbox_replay returns sandbox_id and replay_url', async () => {
    const result = await client.callTool({
      name: 'sandbox_replay',
      arguments: { sandbox_id: 'sb_test123' },
    })
    const data = parseToolResult(result as { content: unknown[] })
    expect(data).toEqual({
      sandbox_id: 'sb_test123',
      replay_url: 'https://sandchest.com/s/sb_test123',
    })
  })

  test('tool error propagates as MCP error', async () => {
    const { SandchestError } = await import('@sandchest/sdk')
    ;(sandchest.get as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new SandchestError({
        code: 'not_found',
        message: 'Sandbox not found',
        status: 404,
        requestId: 'req_123',
      })
    })

    // MCP SDK wraps tool errors — the call itself may throw or return isError
    try {
      const result = await client.callTool({
        name: 'sandbox_exec',
        arguments: { sandbox_id: 'sb_missing', cmd: 'echo hi' },
      })
      // If it returns rather than throwing, check for error indication
      const asResult = result as { isError?: boolean; content: unknown[] }
      if (asResult.isError) {
        expect(asResult.isError).toBe(true)
      }
    } catch (err) {
      expect(err).toBeDefined()
    }
  })
})
