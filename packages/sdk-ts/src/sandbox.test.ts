import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Sandbox } from './sandbox.js'
import { Session } from './session.js'
import { ExecStream } from './stream.js'
import { HttpClient } from './http.js'
import { ExecFailedError, SandchestError, TimeoutError } from './errors.js'

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
    test('returns ExecStream that yields SSE events', async () => {
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
      const stream = await sandbox.exec('echo hello', { stream: true })

      expect(stream).toBeInstanceOf(ExecStream)
      expect(stream.execId).toBe('ex_s1')

      const events = []
      for await (const event of stream) {
        events.push(event)
      }

      expect(events).toHaveLength(3)
      expect(events[0]).toEqual({ seq: 1, t: 'stdout', data: 'hello\n' })
      expect(events[1]).toEqual({ seq: 2, t: 'stderr', data: 'warn\n' })
      expect(events[2]!.t).toBe('exit')
    })

    test('ExecStream.collect() returns aggregated result', async () => {
      let callCount = 0
      globalThis.fetch = mock(async () => {
        callCount++
        if (callCount === 1) {
          return jsonResponse({ exec_id: 'ex_c1', status: 'queued' }, 202)
        }
        return sseResponse([
          { data: '{"seq":1,"t":"stdout","data":"out\\n"}' },
          { data: '{"seq":2,"t":"stderr","data":"err\\n"}' },
          { data: '{"seq":3,"t":"exit","code":0,"duration_ms":30,"resource_usage":{"cpu_ms":5,"peak_memory_bytes":512}}' },
        ])
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      const stream = await sandbox.exec('echo hello', { stream: true })
      const result = await stream.collect()

      expect(result.execId).toBe('ex_c1')
      expect(result.stdout).toBe('out\n')
      expect(result.stderr).toBe('err\n')
      expect(result.exitCode).toBe(0)
      expect(result.durationMs).toBe(30)
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
    test('calls stop() when status is running', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse({ sandbox_id: 'sb_x', status: 'stopping' }, 202),
      ) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await sandbox[Symbol.asyncDispose]()
      expect(sandbox.status).toBe('stopping')
    })

    test('skips stop() when status is stopped', async () => {
      let fetchCalled = false
      globalThis.fetch = mock(async () => {
        fetchCalled = true
        return jsonResponse({ sandbox_id: 'sb_x', status: 'stopped' })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'stopped', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await sandbox[Symbol.asyncDispose]()

      expect(fetchCalled).toBe(false)
      expect(sandbox.status).toBe('stopped')
    })

    test('skips stop() when status is deleted', async () => {
      let fetchCalled = false
      globalThis.fetch = mock(async () => {
        fetchCalled = true
        return jsonResponse({ sandbox_id: 'sb_x', status: 'deleted' })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'deleted', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await sandbox[Symbol.asyncDispose]()

      expect(fetchCalled).toBe(false)
    })
  })

  describe('git operations', () => {
    test('git.clone builds an array-form clone command with safe defaults', async () => {
      let capturedBody = ''
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string
        return jsonResponse({
          exec_id: 'ex_git',
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: 'Cloning into...',
          duration_ms: 321,
          resource_usage: { cpu_ms: 10, peak_memory_bytes: 1024 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      const result = await sandbox.git.clone('https://github.com/org/repo.git', {
        dest: '/work/repo',
        branch: 'main',
        depth: 1,
        env: { GIT_TRACE: '1' },
      })

      const body = JSON.parse(capturedBody)
      expect(body.cmd).toEqual([
        'git',
        'clone',
        '--branch',
        'main',
        '--depth',
        '1',
        '--single-branch',
        '--',
        'https://github.com/org/repo.git',
        '/work/repo',
      ])
      expect(body.timeout_seconds).toBe(120)
      expect(body.env).toEqual({
        GIT_TERMINAL_PROMPT: '0',
        GIT_TRACE: '1',
      })
      expect(result).toEqual({
        execId: 'ex_git',
        exitCode: 0,
        stdout: '',
        stderr: 'Cloning into...',
        durationMs: 321,
      })
    })

    test('git.clone omits --single-branch when disabled', async () => {
      let capturedBody = ''
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string
        return jsonResponse({
          exec_id: 'ex_git',
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 20,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await sandbox.git.clone('https://github.com/org/repo.git', {
        singleBranch: false,
        timeout: 45,
      })

      const body = JSON.parse(capturedBody)
      expect(body.cmd).toEqual([
        'git',
        'clone',
        '--',
        'https://github.com/org/repo.git',
        '/work',
      ])
      expect(body.timeout_seconds).toBe(45)
    })

    test('git.clone rejects URLs with embedded credentials before making a request', async () => {
      let fetchCalled = false
      globalThis.fetch = mock(async () => {
        fetchCalled = true
        return jsonResponse({})
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())

      await expect(
        sandbox.git.clone('https://user:token@github.com/org/repo.git'),
      ).rejects.toMatchObject({
        name: 'ExecFailedError',
        operation: 'git.clone',
      })
      expect(fetchCalled).toBe(false)
    })

    test('git.clone rejects malformed URLs before making a request', async () => {
      let fetchCalled = false
      globalThis.fetch = mock(async () => {
        fetchCalled = true
        return jsonResponse({})
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())

      await expect(sandbox.git.clone('https://')).rejects.toMatchObject({
        name: 'ExecFailedError',
        operation: 'git.clone',
        stderr: 'Invalid git URL: https://.',
      })
      expect(fetchCalled).toBe(false)
    })

    test('git.clone rejects branch names starting with a dash', async () => {
      let fetchCalled = false
      globalThis.fetch = mock(async () => {
        fetchCalled = true
        return jsonResponse({})
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())

      await expect(
        sandbox.git.clone('https://github.com/org/repo.git', { branch: '--upload-pack=sh' }),
      ).rejects.toMatchObject({
        name: 'ExecFailedError',
        operation: 'git.clone',
      })
      expect(fetchCalled).toBe(false)
    })
  })

  describe('tool operations', () => {
    test('tools.find constructs the expected find command', async () => {
      let capturedBody = ''
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string
        return jsonResponse({
          exec_id: 'ex_find',
          status: 'done',
          exit_code: 0,
          stdout: '/app/src/a.ts\n/app/src/b.ts\n',
          stderr: '',
          duration_ms: 12,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      const result = await sandbox.tools.find('/app/src', '*.ts', {
        maxDepth: 2,
        type: 'f',
      })

      expect(JSON.parse(capturedBody).cmd).toEqual([
        'find',
        '--',
        '/app/src',
        '-maxdepth',
        '2',
        '-type',
        'f',
        '-name',
        '*.ts',
      ])
      expect(result).toEqual(['/app/src/a.ts', '/app/src/b.ts'])
    })

    test('tools.find treats a path starting with a dash as a path, not an option', async () => {
      let capturedBody = ''
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string
        return jsonResponse({
          exec_id: 'ex_find',
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 5,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await sandbox.tools.find('-tmp', '*.txt')

      expect(JSON.parse(capturedBody).cmd.slice(0, 3)).toEqual(['find', '--', '-tmp'])
    })

    test('tools.find returns an empty array on non-zero exit', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse({
          exec_id: 'ex_find',
          status: 'done',
          exit_code: 1,
          stdout: '',
          stderr: 'find: missing',
          duration_ms: 3,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        }),
      ) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await expect(sandbox.tools.find('/missing', '*.ts')).resolves.toEqual([])
    })

    test('tools.find propagates API failures instead of treating them as no matches', async () => {
      globalThis.fetch = mock(async () =>
        jsonResponse(
          {
            code: 'internal_error',
            message: 'boom',
          },
          500,
        ),
      ) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await expect(sandbox.tools.find('/app', '*.ts')).rejects.toBeInstanceOf(SandchestError)
    })

    test('tools.replace uploads temp files, runs python, and cleans up', async () => {
      const calls: Array<{ method: string; url: string; body: unknown }> = []
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        const urlString = String(url)
        calls.push({
          method: init?.method ?? 'GET',
          url: urlString,
          body: init?.body,
        })

        if (urlString.includes('/files')) {
          return new Response(null, { status: 204 })
        }

        return jsonResponse({
          exec_id: `ex_${calls.length}`,
          status: 'done',
          exit_code: 0,
          stdout: '/app/src/a.ts\0/app/src/b.ts\0',
          stderr: 'Replaced in 2 file(s)',
          duration_ms: 20,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      const result = await sandbox.tools.replace('/app', 'oldValue', 'newValue', { glob: '*.ts' })

      const fileCalls = calls.filter((call) => call.url.includes('/files'))
      expect(fileCalls).toHaveLength(2)
      expect(new TextDecoder().decode(fileCalls[0]!.body as Uint8Array)).toBe('oldValue')
      expect(new TextDecoder().decode(fileCalls[1]!.body as Uint8Array)).toBe('newValue')

      const execBodies = calls
        .filter((call) => call.url.endsWith('/v1/sandboxes/sb_x/exec'))
        .map((call) => JSON.parse((call.body as string) ?? '{}'))
      expect(execBodies[0]!.cmd[0]).toBe('python3')
      expect(execBodies[0]!.cmd[2]).toContain('MAX_FILE_SIZE')
      expect(execBodies[0]!.cmd[5]).toBe('/app')
      expect(execBodies[0]!.cmd[6]).toBe('*.ts')
      expect(execBodies[1]!.cmd).toEqual([
        'rm',
        '-f',
        expect.stringMatching(/^\/tmp\/\.sandchest-search-/),
      ])
      expect(execBodies[2]!.cmd).toEqual([
        'rm',
        '-f',
        expect.stringMatching(/^\/tmp\/\.sandchest-replace-/),
      ])

      expect(result).toEqual({
        filesChanged: 2,
        changedPaths: ['/app/src/a.ts', '/app/src/b.ts'],
      })
      expect(result).not.toHaveProperty('execId')
      expect(result).not.toHaveProperty('stdout')
    })

    test('tools.replace returns an empty change set when nothing matches', async () => {
      let execCall = 0
      globalThis.fetch = mock(async (url: string | URL | Request) => {
        const urlString = String(url)
        if (urlString.includes('/files')) {
          return new Response(null, { status: 204 })
        }

        execCall++
        return jsonResponse({
          exec_id: `ex_${execCall}`,
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: 'Replaced in 0 file(s)',
          duration_ms: 10,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await expect(sandbox.tools.replace('/app', 'missing', 'present')).resolves.toEqual({
        filesChanged: 0,
        changedPaths: [],
      })
    })

    test('tools.replace throws when python3 is unavailable and still cleans up temp files', async () => {
      let execCall = 0
      const calls: Array<{ url: string; body?: string | null }> = []
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        const urlString = String(url)
        calls.push({
          url: urlString,
          body: typeof init?.body === 'string' ? init.body : null,
        })

        if (urlString.includes('/files')) {
          return new Response(null, { status: 204 })
        }

        execCall++
        if (execCall === 1) {
          return jsonResponse({
            exec_id: 'ex_replace',
            status: 'done',
            exit_code: 127,
            stdout: '',
            stderr: 'python3: not found',
            duration_ms: 2,
            resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
          })
        }

        return jsonResponse({
          exec_id: `ex_cleanup_${execCall}`,
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 1,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())

      await expect(sandbox.tools.replace('/app', 'a', 'b')).rejects.toMatchObject({
        name: 'ExecFailedError',
        operation: 'replace',
        exitCode: 127,
        stderr: 'python3: not found',
      })

      const execBodies = calls
        .filter((call) => call.url.endsWith('/v1/sandboxes/sb_x/exec'))
        .map((call) => JSON.parse(call.body ?? '{}'))
      expect(execBodies).toHaveLength(3)
      expect(execBodies[1]!.cmd).toEqual([
        'rm',
        '-f',
        expect.stringMatching(/^\/tmp\/\.sandchest-search-/),
      ])
      expect(execBodies[2]!.cmd).toEqual([
        'rm',
        '-f',
        expect.stringMatching(/^\/tmp\/\.sandchest-replace-/),
      ])
    })

    test('tools.replace cleans up after a partial upload failure', async () => {
      let fileCall = 0
      const calls: Array<{ url: string; body?: string | null }> = []
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        const urlString = String(url)
        calls.push({
          url: urlString,
          body: typeof init?.body === 'string' ? init.body : null,
        })

        if (urlString.includes('/files')) {
          fileCall++
          if (fileCall === 2) {
            return jsonResponse(
              {
                code: 'internal_error',
                message: 'upload failed',
              },
              500,
            )
          }
          return new Response(null, { status: 204 })
        }

        return jsonResponse({
          exec_id: 'ex_cleanup',
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 1,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await expect(sandbox.tools.replace('/app', 'a', 'b')).rejects.toThrow()

      const execBodies = calls
        .filter((call) => call.url.endsWith('/v1/sandboxes/sb_x/exec'))
        .map((call) => JSON.parse(call.body ?? '{}'))
      expect(execBodies).toHaveLength(2)
      expect(execBodies[0]!.cmd).toEqual([
        'rm',
        '-f',
        expect.stringMatching(/^\/tmp\/\.sandchest-search-/),
      ])
      expect(execBodies[1]!.cmd).toEqual([
        'rm',
        '-f',
        expect.stringMatching(/^\/tmp\/\.sandchest-replace-/),
      ])
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

    test('fs.write encodes text as UTF-8 and uploads it', async () => {
      let capturedBody: Uint8Array | undefined
      let capturedMethod = ''
      let capturedUrl = ''
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body instanceof Uint8Array ? init.body : undefined
        capturedMethod = init?.method ?? ''
        capturedUrl = String(url)
        return jsonResponse({ path: '/tmp/file.txt', bytes_written: 6, batch: false })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await sandbox.fs.write('/tmp/file.txt', 'hello!')

      expect(capturedMethod).toBe('PUT')
      expect(capturedUrl).toContain('path=%2Ftmp%2Ffile.txt')
      expect(capturedBody).toBeInstanceOf(Uint8Array)
      expect(new TextDecoder().decode(capturedBody)).toBe('hello!')
    })

    test('fs.uploadDir uploads a temp archive, validates, extracts, and cleans up', async () => {
      const calls: Array<{ url: string; body?: string | null; method: string }> = []
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        const urlString = String(url)
        calls.push({
          url: urlString,
          body: typeof init?.body === 'string' ? init.body : null,
          method: init?.method ?? 'GET',
        })

        if (urlString.includes('/files')) {
          return new Response(null, { status: 204 })
        }

        return jsonResponse({
          exec_id: 'ex_1',
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 10,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await sandbox.fs.uploadDir('/app', new Uint8Array(10))

      expect(calls[0]!.method).toBe('PUT')
      expect(calls[0]!.url).toContain('batch=true')
      expect(calls[0]!.url).toContain('path=%2Ftmp%2F.sandchest-upload-')

      const execBodies = calls
        .filter((call) => call.url.endsWith('/v1/sandboxes/sb_x/exec'))
        .map((call) => JSON.parse(call.body ?? '{}'))
      expect(execBodies[0]!.cmd).toEqual(['mkdir', '-p', '/app'])
      expect(execBodies[1]!.cmd[0]).toBe('python3')
      expect(execBodies[1]!.cmd[2]).toContain('Tarball contains unsafe entries')
      expect(execBodies[2]!.cmd).toEqual([
        'tar',
        'xzf',
        expect.stringMatching(/^\/tmp\/\.sandchest-upload-/),
        '--no-same-owner',
        '-C',
        '/app',
      ])
      expect(execBodies[3]!.cmd).toEqual([
        'rm',
        '-f',
        expect.stringMatching(/^\/tmp\/\.sandchest-upload-/),
      ])
    })

    test('fs.uploadDir cleans up temp archive when extraction fails', async () => {
      let execCall = 0
      const calls: Array<{ url: string; body?: string | null }> = []
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        const urlString = String(url)
        calls.push({
          url: urlString,
          body: typeof init?.body === 'string' ? init.body : null,
        })

        if (urlString.includes('/files')) {
          return new Response(null, { status: 204 })
        }

        execCall++
        if (execCall === 3) {
          return jsonResponse({
            exec_id: 'ex_fail',
            status: 'done',
            exit_code: 2,
            stdout: '',
            stderr: 'tar failed',
            duration_ms: 10,
            resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
          })
        }

        return jsonResponse({
          exec_id: `ex_${execCall}`,
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 10,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await expect(sandbox.fs.uploadDir('/app', new Uint8Array(10))).rejects.toBeInstanceOf(
        ExecFailedError,
      )

      const cleanupBody = calls
        .filter((call) => call.url.endsWith('/v1/sandboxes/sb_x/exec'))
        .map((call) => JSON.parse(call.body ?? '{}'))
        .at(-1)
      expect(cleanupBody?.cmd).toEqual([
        'rm',
        '-f',
        expect.stringMatching(/^\/tmp\/\.sandchest-upload-/),
      ])
    })

    test('fs.uploadDir reports the compound operation when exec does not complete', async () => {
      let execCall = 0
      const calls: Array<{ url: string; body?: string | null }> = []
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        const urlString = String(url)
        calls.push({
          url: urlString,
          body: typeof init?.body === 'string' ? init.body : null,
        })

        if (urlString.includes('/files')) {
          return new Response(null, { status: 204 })
        }

        execCall++
        if (execCall === 2) {
          return jsonResponse({
            exec_id: 'ex_verify',
            status: 'timed_out',
            exit_code: 124,
            stdout: '',
            stderr: '',
            duration_ms: 30_000,
            resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
          })
        }

        return jsonResponse({
          exec_id: `ex_${execCall}`,
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 10,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())

      try {
        await sandbox.fs.uploadDir('/app', new Uint8Array(10))
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ExecFailedError)
        expect((err as ExecFailedError).operation).toBe('uploadDir:verify')
        expect((err as ExecFailedError).stderr).toContain('timed_out')
      }

      const cleanupBody = calls
        .filter((call) => call.url.endsWith('/v1/sandboxes/sb_x/exec'))
        .map((call) => JSON.parse(call.body ?? '{}'))
        .at(-1)
      expect(cleanupBody?.cmd).toEqual([
        'rm',
        '-f',
        expect.stringMatching(/^\/tmp\/\.sandchest-upload-/),
      ])
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

    test('fs.read decodes UTF-8 content', async () => {
      globalThis.fetch = mock(async () =>
        new Response(new TextEncoder().encode('hello world'), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
      ) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      const text = await sandbox.fs.read('/tmp/file.txt')

      expect(text).toBe('hello world')
    })

    test('fs.downloadDir creates an archive, downloads it, and cleans up', async () => {
      const calls: Array<{ url: string; body?: string | null }> = []
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        const urlString = String(url)
        calls.push({
          url: urlString,
          body: typeof init?.body === 'string' ? init.body : null,
        })

        if (urlString.includes('/files') && init?.method === 'GET') {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' },
          })
        }

        return jsonResponse({
          exec_id: 'ex_1',
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 10,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      const archive = await sandbox.fs.downloadDir('/app')

      expect(archive).toEqual(new Uint8Array([1, 2, 3]))

      const execBodies = calls
        .filter((call) => call.url.endsWith('/v1/sandboxes/sb_x/exec'))
        .map((call) => JSON.parse(call.body ?? '{}'))
      expect(execBodies[0]!.cmd).toEqual([
        'tar',
        'czf',
        expect.stringMatching(/^\/tmp\/\.sandchest-download-/),
        '-C',
        '/app',
        '.',
      ])
      expect(calls.find((call) => call.url.includes('/files'))?.url).toContain(
        'path=%2Ftmp%2F.sandchest-download-',
      )
      expect(execBodies[1]!.cmd).toEqual([
        'rm',
        '-f',
        expect.stringMatching(/^\/tmp\/\.sandchest-download-/),
      ])
    })

    test('fs.downloadDir cleans up temp archive when tar creation fails', async () => {
      let execCall = 0
      const calls: Array<{ url: string; body?: string | null }> = []
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        const urlString = String(url)
        calls.push({
          url: urlString,
          body: typeof init?.body === 'string' ? init.body : null,
        })

        if (urlString.includes('/files')) {
          return new Response(new Uint8Array([1]), {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' },
          })
        }

        execCall++
        if (execCall === 1) {
          return jsonResponse({
            exec_id: 'ex_archive',
            status: 'done',
            exit_code: 1,
            stdout: '',
            stderr: 'missing path',
            duration_ms: 10,
            resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
          })
        }

        return jsonResponse({
          exec_id: 'ex_cleanup',
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 10,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())
      await expect(sandbox.fs.downloadDir('/missing')).rejects.toBeInstanceOf(ExecFailedError)

      const execBodies = calls
        .filter((call) => call.url.endsWith('/v1/sandboxes/sb_x/exec'))
        .map((call) => JSON.parse(call.body ?? '{}'))
      expect(execBodies).toHaveLength(2)
      expect(execBodies[1]!.cmd).toEqual([
        'rm',
        '-f',
        expect.stringMatching(/^\/tmp\/\.sandchest-download-/),
      ])
    })

    test('fs.downloadDir cleans up temp archive when exec does not complete', async () => {
      let execCall = 0
      const calls: Array<{ url: string; body?: string | null }> = []
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        const urlString = String(url)
        calls.push({
          url: urlString,
          body: typeof init?.body === 'string' ? init.body : null,
        })

        if (urlString.includes('/files')) {
          return new Response(new Uint8Array([1]), {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' },
          })
        }

        execCall++
        if (execCall === 1) {
          return jsonResponse({
            exec_id: 'ex_archive',
            status: 'timed_out',
            exit_code: 124,
            stdout: '',
            stderr: '',
            duration_ms: 30_000,
            resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
          })
        }

        return jsonResponse({
          exec_id: 'ex_cleanup',
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 10,
          resource_usage: { cpu_ms: 1, peak_memory_bytes: 1 },
        })
      }) as unknown as typeof fetch

      const sandbox = new Sandbox('sb_x', 'running', 'https://replay.sandchest.com/sb_x', createMockHttp())

      try {
        await sandbox.fs.downloadDir('/missing')
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ExecFailedError)
        expect((err as ExecFailedError).operation).toBe('downloadDir:archive')
        expect((err as ExecFailedError).stderr).toContain('timed_out')
      }

      const execBodies = calls
        .filter((call) => call.url.endsWith('/v1/sandboxes/sb_x/exec'))
        .map((call) => JSON.parse(call.body ?? '{}'))
      expect(execBodies).toHaveLength(2)
      expect(execBodies[1]!.cmd).toEqual([
        'rm',
        '-f',
        expect.stringMatching(/^\/tmp\/\.sandchest-download-/),
      ])
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
