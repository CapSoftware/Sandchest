import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Sandbox } from './sandbox.js'
import { Session } from './session.js'
import { HttpClient } from './http.js'
import { TimeoutError } from './errors.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sseResponse(events: Array<{ id?: string; data: string }>): Response {
  const text = events.map((e) => {
    let chunk = ''
    if (e.id) chunk += `id: ${e.id}\n`
    chunk += `data: ${e.data}\n\n`
    return chunk
  }).join('')

  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('Sandbox', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function createMockHttp(): HttpClient {
    return new HttpClient({
      apiKey: 'sk_test',
      baseUrl: 'https://api.sandchest.com',
      timeout: 30_000,
      retries: 0,
    })
  }

  test('stores id, status, replayUrl, and http client', () => {
    const http = createMockHttp()
    const sandbox = new Sandbox('sb_abc123', 'running', 'https://replay.sandchest.com/sb_abc123', http)

    expect(sandbox.id).toBe('sb_abc123')
    expect(sandbox.status).toBe('running')
    expect(sandbox.replayUrl).toBe('https://replay.sandchest.com/sb_abc123')
    expect(sandbox._http).toBe(http)
  })

  test('status is mutable', () => {
    const sandbox = new Sandbox('sb_x', 'queued', 'https://replay.sandchest.com/sb_x', createMockHttp())
    sandbox.status = 'running'
    expect(sandbox.status).toBe('running')
  })

  describe('exec (blocking)', () => {
    test('sends POST to /v1/sandboxes/:id/exec with wait: true', async () => {
      let capturedUrl = ''
      let capturedBody = ''
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url)
        capturedBody = init?.body as string
        return jsonResponse({
          exec_id: 'ex_123',
          status: 'done',
          exit_code: 0,
          stdout: 'hello\n',
          stderr: '',
          duration_ms: 42,
          resource_usage: { cpu_ms: 10, peak_memory_bytes: 1024 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      const result = await sandbox.exec('echo hello')

      expect(capturedUrl).toBe('https://api.sandchest.com/v1/sandboxes/sb_x/exec')
      const body = JSON.parse(capturedBody)
      expect(body.cmd).toBe('echo hello')
      expect(body.wait).toBe(true)
      expect(result.execId).toBe('ex_123')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('hello\n')
      expect(result.stderr).toBe('')
      expect(result.durationMs).toBe(42)
    })

    test('passes exec options (cwd, env, timeout)', async () => {
      let capturedBody = ''
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string
        return jsonResponse({
          exec_id: 'ex_456',
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 10,
          resource_usage: { cpu_ms: 5, peak_memory_bytes: 512 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await sandbox.exec(['ls', '-la'], { cwd: '/tmp', env: { FOO: 'bar' }, timeout: 60 })

      const body = JSON.parse(capturedBody)
      expect(body.cmd).toEqual(['ls', '-la'])
      expect(body.cwd).toBe('/tmp')
      expect(body.env).toEqual({ FOO: 'bar' })
      expect(body.timeout_seconds).toBe(60)
    })
  })

  describe('exec (streaming)', () => {
    test('returns async iterable of SSE events', async () => {
      let callCount = 0
      globalThis.fetch = mock(async () => {
        callCount++
        if (callCount === 1) {
          return jsonResponse({ exec_id: 'ex_s1', status: 'queued' }, 202)
        }
        return sseResponse([
          { data: '{"seq":1,"t":"stdout","data":"hello\\n"}' },
          { data: '{"seq":2,"t":"stderr","data":"warn\\n"}' },
          { data: '{"seq":3,"t":"exit","code":0,"duration_ms":50,"resource_usage":{"cpu_ms":10,"peak_memory_bytes":1024}}' },
        ])
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      const events = []
      for await (const event of sandbox.exec('echo hello', { stream: true })) {
        events.push(event)
      }

      expect(events).toHaveLength(3)
      expect(events[0]).toEqual({ seq: 1, t: 'stdout', data: 'hello\n' })
      expect(events[1]).toEqual({ seq: 2, t: 'stderr', data: 'warn\n' })
      expect(events[2]!.t).toBe('exit')
    })
  })

  describe('exec (with callbacks)', () => {
    test('invokes onStdout and onStderr callbacks and returns full result', async () => {
      let callCount = 0
      globalThis.fetch = mock(async () => {
        callCount++
        if (callCount === 1) {
          return jsonResponse({ exec_id: 'ex_cb1', status: 'queued' }, 202)
        }
        return sseResponse([
          { data: '{"seq":1,"t":"stdout","data":"line1\\n"}' },
          { data: '{"seq":2,"t":"stderr","data":"err1\\n"}' },
          { data: '{"seq":3,"t":"stdout","data":"line2\\n"}' },
          { data: '{"seq":4,"t":"exit","code":0,"duration_ms":100,"resource_usage":{"cpu_ms":20,"peak_memory_bytes":2048}}' },
        ])
      }) as unknown as typeof fetch

      const stdoutChunks: string[] = []
      const stderrChunks: string[] = []

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      const result = await sandbox.exec('make build', {
        onStdout: (data) => stdoutChunks.push(data),
        onStderr: (data) => stderrChunks.push(data),
      })

      expect(stdoutChunks).toEqual(['line1\n', 'line2\n'])
      expect(stderrChunks).toEqual(['err1\n'])
      expect(result.execId).toBe('ex_cb1')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('line1\nline2\n')
      expect(result.stderr).toBe('err1\n')
      expect(result.durationMs).toBe(100)
    })
  })

  describe('fork', () => {
    test('sends POST to /v1/sandboxes/:id/fork and returns new Sandbox', async () => {
      let capturedUrl = ''
      let capturedBody = ''
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url)
        capturedBody = init?.body as string
        return jsonResponse({
          sandbox_id: 'sb_fork1',
          forked_from: 'sb_x',
          status: 'queued',
          replay_url: 'https://replay.sandchest.com/sb_fork1',
          created_at: '2024-01-01T00:00:00Z',
        }, 201)
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      const forked = await sandbox.fork({ env: { MODE: 'fork' }, ttlSeconds: 3600 })

      expect(capturedUrl).toBe('https://api.sandchest.com/v1/sandboxes/sb_x/fork')
      const body = JSON.parse(capturedBody)
      expect(body.env).toEqual({ MODE: 'fork' })
      expect(body.ttl_seconds).toBe(3600)
      expect(forked).toBeInstanceOf(Sandbox)
      expect(forked.id).toBe('sb_fork1')
      expect(forked.status).toBe('queued')
    })
  })

  describe('forks', () => {
    test('sends GET to /v1/sandboxes/:id/forks and returns ForkTree', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse({
          root: 'sb_root',
          tree: [
            {
              sandbox_id: 'sb_root',
              status: 'running',
              forked_from: null,
              forked_at: null,
              children: ['sb_child1'],
            },
            {
              sandbox_id: 'sb_child1',
              status: 'stopped',
              forked_from: 'sb_root',
              forked_at: '2024-01-01T00:05:00Z',
              children: [],
            },
          ],
        }),
      ) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_root', 'running', 'https://replay.sandchest.com/sb_root', createMockHttp())
      const forkTree = await sandbox.forks()

      expect(forkTree.root).toBe('sb_root')
      expect(forkTree.tree).toHaveLength(2)
      expect(forkTree.tree[0]!.sandbox_id).toBe('sb_root')
      expect(forkTree.tree[1]!.sandbox_id).toBe('sb_child1')
    })
  })

  describe('stop', () => {
    test('sends POST to /v1/sandboxes/:id/stop and updates status', async () => {
      let capturedUrl = ''
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        capturedUrl = String(url)
        return jsonResponse({ sandbox_id: 'sb_x', status: 'stopping' }, 202)
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await sandbox.stop()

      expect(capturedUrl).toBe('https://api.sandchest.com/v1/sandboxes/sb_x/stop')
      expect(sandbox.status).toBe('stopping')
    })
  })

  describe('destroy', () => {
    test('sends DELETE to /v1/sandboxes/:id and sets status to deleted', async () => {
      let capturedUrl = ''
      let capturedMethod = ''
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url)
        capturedMethod = init?.method ?? ''
        return jsonResponse({ sandbox_id: 'sb_x', status: 'deleted' })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await sandbox.destroy()

      expect(capturedUrl).toBe('https://api.sandchest.com/v1/sandboxes/sb_x')
      expect(capturedMethod).toBe('DELETE')
      expect(sandbox.status).toBe('deleted')
    })
  })

  describe('waitReady', () => {
    test('resolves immediately when status is already running', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse({
          sandbox_id: 'sb_x',
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
          replay_url: 'https://replay.sandchest.com/sb_x',
        }),
      ) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'queued', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await sandbox.waitReady()
      expect(sandbox.status).toBe('running')
    })

    test('throws on terminal state (failed)', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse({
          sandbox_id: 'sb_x',
          status: 'failed',
          image: 'ubuntu-22.04',
          profile: 'small',
          env: {},
          forked_from: null,
          fork_count: 0,
          created_at: '2024-01-01T00:00:00Z',
          started_at: null,
          ended_at: null,
          failure_reason: 'provision_failed',
          replay_url: 'https://replay.sandchest.com/sb_x',
        }),
      ) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'queued', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await expect(sandbox.waitReady()).rejects.toThrow('terminal state: failed')
    })

    test('throws TimeoutError when timeout elapses', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse({
          sandbox_id: 'sb_x',
          status: 'provisioning',
          image: 'ubuntu-22.04',
          profile: 'small',
          env: {},
          forked_from: null,
          fork_count: 0,
          created_at: '2024-01-01T00:00:00Z',
          started_at: null,
          ended_at: null,
          failure_reason: null,
          replay_url: 'https://replay.sandchest.com/sb_x',
        }),
      ) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'queued', 'https://replay.sandchest.com/sb_x', createMockHttp())
      try {
        await sandbox.waitReady({ timeout: 50 })
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(TimeoutError)
        expect((err as TimeoutError).message).toContain('did not become ready')
      }
    })
  })

  describe('Symbol.asyncDispose', () => {
    test('calls stop()', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse({ sandbox_id: 'sb_x', status: 'stopping' }, 202),
      ) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await sandbox[Symbol.asyncDispose]()
      expect(sandbox.status).toBe('stopping')
    })
  })

  describe('fs operations', () => {
    test('fs.upload sends PUT with binary body', async () => {
      let capturedUrl = ''
      let capturedHeaders: Record<string, string> = {}
      let capturedMethod = ''
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url)
        capturedMethod = init?.method ?? ''
        capturedHeaders = init?.headers as Record<string, string>
        return jsonResponse({ path: '/tmp/file.txt', bytes_written: 5, batch: false })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await sandbox.fs.upload('/tmp/file.txt', new Uint8Array([104, 101, 108, 108, 111]))

      expect(capturedMethod).toBe('PUT')
      expect(capturedUrl).toContain('/v1/sandboxes/sb_x/files')
      expect(capturedUrl).toContain('path=%2Ftmp%2Ffile.txt')
      expect(capturedHeaders['Content-Type']).toBe('application/octet-stream')
    })

    test('fs.uploadDir sends PUT with batch=true', async () => {
      let capturedUrl = ''
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        capturedUrl = String(url)
        return jsonResponse({ path: '/app', bytes_written: 1024, batch: true })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await sandbox.fs.uploadDir('/app', new Uint8Array(10))

      expect(capturedUrl).toContain('batch=true')
    })

    test('fs.download returns Uint8Array', async () => {
      globalThis.fetch = mock(async () =>
        new Response(new Uint8Array([72, 73]), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      ) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      const data = await sandbox.fs.download('/tmp/file.txt')

      expect(data).toBeInstanceOf(Uint8Array)
      expect(data.length).toBe(2)
      expect(data[0]).toBe(72)
    })

    test('fs.ls returns file entries', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse({
          files: [
            { name: 'file.txt', path: '/tmp/file.txt', type: 'file', size_bytes: 100 },
            { name: 'dir', path: '/tmp/dir', type: 'directory', size_bytes: null },
          ],
          next_cursor: null,
        }),
      ) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      const files = await sandbox.fs.ls('/tmp')

      expect(files).toHaveLength(2)
      expect(files[0]!.name).toBe('file.txt')
      expect(files[0]!.type).toBe('file')
      expect(files[1]!.type).toBe('directory')
    })

    test('fs.rm sends DELETE', async () => {
      let capturedMethod = ''
      let capturedUrl = ''
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url)
        capturedMethod = init?.method ?? ''
        return jsonResponse({ ok: true })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await sandbox.fs.rm('/tmp/file.txt')

      expect(capturedMethod).toBe('DELETE')
      expect(capturedUrl).toContain('/v1/sandboxes/sb_x/files')
    })
  })

  describe('artifact operations', () => {
    test('artifacts.register sends POST with paths', async () => {
      let capturedBody = ''
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string
        return jsonResponse({ registered: 2, total: 3 })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      const result = await sandbox.artifacts.register(['/out/a.txt', '/out/b.txt'])

      const body = JSON.parse(capturedBody)
      expect(body.paths).toEqual(['/out/a.txt', '/out/b.txt'])
      expect(result.registered).toBe(2)
      expect(result.total).toBe(3)
    })

    test('artifacts.list returns artifact array', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse({
          artifacts: [
            {
              id: 'art_1',
              name: 'output.txt',
              mime: 'text/plain',
              bytes: 256,
              sha256: 'abc123',
              download_url: 'https://storage.example.com/art_1',
              exec_id: 'ex_1',
              created_at: '2024-01-01T00:00:00Z',
            },
          ],
          next_cursor: null,
        }),
      ) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      const artifacts = await sandbox.artifacts.list()

      expect(artifacts).toHaveLength(1)
      expect(artifacts[0]!.name).toBe('output.txt')
      expect(artifacts[0]!.download_url).toBe('https://storage.example.com/art_1')
    })
  })

  describe('session.create', () => {
    test('sends POST to /v1/sandboxes/:id/sessions and returns Session', async () => {
      let capturedUrl = ''
      let capturedBody = ''
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url)
        capturedBody = init?.body as string
        return jsonResponse({ session_id: 'sess_new', status: 'running' }, 201)
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      const session = await sandbox.session.create({ shell: '/bin/zsh', env: { TERM: 'xterm' } })

      expect(capturedUrl).toBe('https://api.sandchest.com/v1/sandboxes/sb_x/sessions')
      const body = JSON.parse(capturedBody)
      expect(body.shell).toBe('/bin/zsh')
      expect(body.env).toEqual({ TERM: 'xterm' })
      expect(session).toBeInstanceOf(Session)
      expect(session.id).toBe('sess_new')
    })
  })
})
