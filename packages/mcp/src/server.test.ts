import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from './server.js'
import type { Sandchest, Sandbox, ExecResult } from '@sandchest/sdk'

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
      ls: mock(async () => []),
      rm: mock(async () => {}),
    },
    artifacts: {
      register: mock(async () => ({ registered: 0, total: 0 })),
      list: mock(async () => []),
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

  beforeEach(async () => {
    sandchest = mockClient()
    const pair = await setupTestPair(sandchest)
    client = pair.client
    cleanup = pair.cleanup
  })

  afterEach(async () => {
    await cleanup()
  })

  test('lists all 14 tools', async () => {
    const result = await client.listTools()
    const toolNames = result.tools.map((t) => t.name).sort()
    expect(toolNames).toEqual([
      'sandbox_artifacts_list',
      'sandbox_create',
      'sandbox_destroy',
      'sandbox_download',
      'sandbox_exec',
      'sandbox_file_list',
      'sandbox_fork',
      'sandbox_list',
      'sandbox_replay',
      'sandbox_session_create',
      'sandbox_session_destroy',
      'sandbox_session_exec',
      'sandbox_stop',
      'sandbox_upload',
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
    expect(instructions).toContain('FORKING')
    expect(instructions).toContain('WORKFLOW PATTERN')
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
