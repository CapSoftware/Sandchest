import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Sandchest } from './client.js'
import { Sandbox } from './sandbox.js'
import { Session } from './session.js'
import {
  NotFoundError,
  SandboxNotRunningError,
  AuthenticationError,
} from './errors.js'

// ---------------------------------------------------------------------------
// Mock API server — simulates the Sandchest control plane
// ---------------------------------------------------------------------------

interface MockSandbox {
  sandbox_id: string
  status: string
  image: string
  profile: string
  env: Record<string, string>
  forked_from: string | null
  fork_count: number
  created_at: string
  started_at: string | null
  ended_at: string | null
  failure_reason: string | null
  replay_url: string
}

interface MockExec {
  exec_id: string
  sandbox_id: string
  session_id: string | null
  cmd: string | string[]
  status: string
  exit_code: number
  stdout: string
  stderr: string
  duration_ms: number
  resource_usage: { cpu_ms: number; peak_memory_bytes: number }
}

interface MockSession {
  session_id: string
  sandbox_id: string
  shell: string
  status: string
}

interface MockFile {
  path: string
  content: Uint8Array
}

function createMockServer() {
  const sandboxes = new Map<string, MockSandbox>()
  const execs = new Map<string, MockExec>()
  const sessions = new Map<string, MockSession>()
  const files = new Map<string, MockFile>()
  const artifacts = new Map<string, string[]>()
  let nextId = 1

  function genId(prefix: string): string {
    return `${prefix}${nextId++}`
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': `req_${nextId++}`,
      },
    })
  }

  function errorJson(status: number, code: string, message: string): Response {
    return json(
      { error: code, message, request_id: `req_${nextId++}`, retry_after: null },
      status,
    )
  }

  function requireRunning(sandbox: MockSandbox): Response | null {
    if (sandbox.status !== 'running') {
      return errorJson(409, 'sandbox_not_running', `Sandbox is ${sandbox.status}`)
    }
    return null
  }

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname
      const method = req.method

      // Auth check
      const auth = req.headers.get('Authorization')
      if (!auth || auth !== 'Bearer sk_test_e2e') {
        return errorJson(401, 'unauthorized', 'Invalid API key')
      }

      // POST /v1/sandboxes
      if (method === 'POST' && path === '/v1/sandboxes') {
        const body = (await req.json()) as Record<string, unknown>
        const id = genId('sb_')
        const sb: MockSandbox = {
          sandbox_id: id,
          status: 'running',
          image: (body.image as string) ?? 'sandchest://ubuntu-22.04',
          profile: (body.profile as string) ?? 'small',
          env: (body.env as Record<string, string>) ?? {},
          forked_from: null,
          fork_count: 0,
          created_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          ended_at: null,
          failure_reason: null,
          replay_url: `https://replay.sandchest.com/${id}`,
        }
        sandboxes.set(id, sb)
        return json(
          {
            sandbox_id: sb.sandbox_id,
            status: sb.status,
            queue_position: 0,
            estimated_ready_seconds: 0,
            replay_url: sb.replay_url,
            created_at: sb.created_at,
          },
          201,
        )
      }

      // GET /v1/sandboxes
      if (method === 'GET' && path === '/v1/sandboxes') {
        const status = url.searchParams.get('status')
        let list = [...sandboxes.values()]
        if (status) list = list.filter((s) => s.status === status)
        return json({
          sandboxes: list.map((s) => ({
            sandbox_id: s.sandbox_id,
            status: s.status,
            image: s.image,
            profile: s.profile,
            forked_from: s.forked_from,
            created_at: s.created_at,
            replay_url: s.replay_url,
          })),
          next_cursor: null,
        })
      }

      // GET /v1/sandboxes/:id
      const getSandbox = path.match(/^\/v1\/sandboxes\/(sb_\w+)$/)
      if (method === 'GET' && getSandbox) {
        const sb = sandboxes.get(getSandbox[1]!)
        if (!sb) return errorJson(404, 'not_found', 'Sandbox not found')
        return json(sb)
      }

      // DELETE /v1/sandboxes/:id
      const delSandbox = path.match(/^\/v1\/sandboxes\/(sb_\w+)$/)
      if (method === 'DELETE' && delSandbox) {
        const sb = sandboxes.get(delSandbox[1]!)
        if (!sb) return errorJson(404, 'not_found', 'Sandbox not found')
        sb.status = 'deleted'
        return json({ sandbox_id: sb.sandbox_id, status: 'deleted' })
      }

      // POST /v1/sandboxes/:id/stop
      const stopSandbox = path.match(/^\/v1\/sandboxes\/(sb_\w+)\/stop$/)
      if (method === 'POST' && stopSandbox) {
        const sb = sandboxes.get(stopSandbox[1]!)
        if (!sb) return errorJson(404, 'not_found', 'Sandbox not found')
        const err = requireRunning(sb)
        if (err) return err
        sb.status = 'stopping'
        return json({ sandbox_id: sb.sandbox_id, status: 'stopping' })
      }

      // POST /v1/sandboxes/:id/fork
      const forkSandbox = path.match(/^\/v1\/sandboxes\/(sb_\w+)\/fork$/)
      if (method === 'POST' && forkSandbox) {
        const parent = sandboxes.get(forkSandbox[1]!)
        if (!parent) return errorJson(404, 'not_found', 'Sandbox not found')
        const err = requireRunning(parent)
        if (err) return err
        const body = (await req.json()) as Record<string, unknown>
        const forkId = genId('sb_')
        const forked: MockSandbox = {
          sandbox_id: forkId,
          status: 'running',
          image: parent.image,
          profile: parent.profile,
          env: { ...parent.env, ...((body.env as Record<string, string>) ?? {}) },
          forked_from: parent.sandbox_id,
          fork_count: 0,
          created_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          ended_at: null,
          failure_reason: null,
          replay_url: `https://replay.sandchest.com/${forkId}`,
        }
        sandboxes.set(forkId, forked)
        parent.fork_count++
        return json({
          sandbox_id: forkId,
          status: 'running',
          replay_url: forked.replay_url,
          created_at: forked.created_at,
        })
      }

      // GET /v1/sandboxes/:id/forks
      const getForks = path.match(/^\/v1\/sandboxes\/(sb_\w+)\/forks$/)
      if (method === 'GET' && getForks) {
        const sb = sandboxes.get(getForks[1]!)
        if (!sb) return errorJson(404, 'not_found', 'Sandbox not found')
        const children = [...sandboxes.values()].filter(
          (s) => s.forked_from === sb.sandbox_id,
        )
        return json({
          root: sb.sandbox_id,
          tree: children.map((c) => ({
            sandbox_id: c.sandbox_id,
            parent_id: sb.sandbox_id,
            status: c.status,
            created_at: c.created_at,
          })),
        })
      }

      // POST /v1/sandboxes/:id/exec
      const execSandbox = path.match(/^\/v1\/sandboxes\/(sb_\w+)\/exec$/)
      if (method === 'POST' && execSandbox) {
        const sb = sandboxes.get(execSandbox[1]!)
        if (!sb) return errorJson(404, 'not_found', 'Sandbox not found')
        const err = requireRunning(sb)
        if (err) return err
        const body = (await req.json()) as Record<string, unknown>
        const cmd = body.cmd as string | string[]
        const execId = genId('ex_')
        const cmdStr = Array.isArray(cmd) ? cmd.join(' ') : cmd
        const ex: MockExec = {
          exec_id: execId,
          sandbox_id: sb.sandbox_id,
          session_id: null,
          cmd,
          status: 'done',
          exit_code: 0,
          stdout: `mock output of: ${cmdStr}\n`,
          stderr: '',
          duration_ms: 42,
          resource_usage: { cpu_ms: 10, peak_memory_bytes: 1024 },
        }
        execs.set(execId, ex)

        if (body.wait === false) {
          ex.status = 'running'
          return json({ exec_id: execId, status: 'running' }, 202)
        }

        return json({
          exec_id: ex.exec_id,
          status: ex.status,
          exit_code: ex.exit_code,
          stdout: ex.stdout,
          stderr: ex.stderr,
          duration_ms: ex.duration_ms,
          resource_usage: ex.resource_usage,
        })
      }

      // GET /v1/sandboxes/:id/exec/:execId/stream
      const streamExec = path.match(
        /^\/v1\/sandboxes\/(sb_\w+)\/exec\/(ex_\w+)\/stream$/,
      )
      if (method === 'GET' && streamExec) {
        const ex = execs.get(streamExec[2]!)
        if (!ex) return errorJson(404, 'not_found', 'Exec not found')
        ex.status = 'done'
        const events = [
          `data: ${JSON.stringify({ t: 'stdout', data: ex.stdout })}\n\n`,
          ...(ex.stderr
            ? [`data: ${JSON.stringify({ t: 'stderr', data: ex.stderr })}\n\n`]
            : []),
          `data: ${JSON.stringify({ t: 'exit', code: ex.exit_code, duration_ms: ex.duration_ms })}\n\n`,
        ]
        return new Response(events.join(''), {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }

      // POST /v1/sandboxes/:id/sessions
      const createSession = path.match(/^\/v1\/sandboxes\/(sb_\w+)\/sessions$/)
      if (method === 'POST' && createSession) {
        const sb = sandboxes.get(createSession[1]!)
        if (!sb) return errorJson(404, 'not_found', 'Sandbox not found')
        const err = requireRunning(sb)
        if (err) return err
        const body = (await req.json()) as Record<string, unknown>
        const sessId = genId('sess_')
        const sess: MockSession = {
          session_id: sessId,
          sandbox_id: sb.sandbox_id,
          shell: (body.shell as string) ?? '/bin/bash',
          status: 'running',
        }
        sessions.set(sessId, sess)
        return json({ session_id: sessId, status: 'running' }, 201)
      }

      // POST /v1/sandboxes/:id/sessions/:sessId/exec
      const sessExec = path.match(
        /^\/v1\/sandboxes\/(sb_\w+)\/sessions\/(sess_\w+)\/exec$/,
      )
      if (method === 'POST' && sessExec) {
        const sess = sessions.get(sessExec[2]!)
        if (!sess) return errorJson(404, 'not_found', 'Session not found')
        const body = (await req.json()) as Record<string, unknown>
        const execId = genId('ex_')
        const ex: MockExec = {
          exec_id: execId,
          sandbox_id: sess.sandbox_id,
          session_id: sess.session_id,
          cmd: body.cmd as string,
          status: 'done',
          exit_code: 0,
          stdout: `session exec: ${body.cmd}\n`,
          stderr: '',
          duration_ms: 15,
          resource_usage: { cpu_ms: 5, peak_memory_bytes: 512 },
        }
        execs.set(execId, ex)
        return json({
          exec_id: ex.exec_id,
          status: ex.status,
          exit_code: ex.exit_code,
          stdout: ex.stdout,
          stderr: ex.stderr,
          duration_ms: ex.duration_ms,
        })
      }

      // DELETE /v1/sandboxes/:id/sessions/:sessId
      const delSession = path.match(
        /^\/v1\/sandboxes\/(sb_\w+)\/sessions\/(sess_\w+)$/,
      )
      if (method === 'DELETE' && delSession) {
        const sess = sessions.get(delSession[2]!)
        if (!sess) return errorJson(404, 'not_found', 'Session not found')
        sess.status = 'destroyed'
        return json({ ok: true })
      }

      // PUT /v1/sandboxes/:id/files
      const putFile = path.match(/^\/v1\/sandboxes\/(sb_\w+)\/files$/)
      if (method === 'PUT' && putFile) {
        const sb = sandboxes.get(putFile[1]!)
        if (!sb) return errorJson(404, 'not_found', 'Sandbox not found')
        const err = requireRunning(sb)
        if (err) return err
        const filePath = url.searchParams.get('path') ?? '/tmp/unknown'
        const content = new Uint8Array(await req.arrayBuffer())
        const key = `${sb.sandbox_id}:${filePath}`
        files.set(key, { path: filePath, content })
        return json({
          path: filePath,
          bytes_written: content.length,
          batch: url.searchParams.get('batch') === 'true',
        })
      }

      // GET /v1/sandboxes/:id/files (download or list)
      const getFile = path.match(/^\/v1\/sandboxes\/(sb_\w+)\/files$/)
      if (method === 'GET' && getFile) {
        const sb = sandboxes.get(getFile[1]!)
        if (!sb) return errorJson(404, 'not_found', 'Sandbox not found')
        const filePath = url.searchParams.get('path') ?? '/'
        const isList = url.searchParams.get('list') === 'true'

        if (isList) {
          const prefix = `${sb.sandbox_id}:${filePath}`
          const matching = [...files.entries()]
            .filter(([k]) => k.startsWith(prefix))
            .map(([, v]) => ({
              name: v.path.split('/').pop() ?? '',
              path: v.path,
              type: 'file' as const,
              size: v.content.length,
            }))
          return json({ files: matching, next_cursor: null })
        }

        const key = `${sb.sandbox_id}:${filePath}`
        const file = files.get(key)
        if (!file) return errorJson(404, 'not_found', 'File not found')
        return new Response(file.content, {
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      }

      // DELETE /v1/sandboxes/:id/files
      const delFile = path.match(/^\/v1\/sandboxes\/(sb_\w+)\/files$/)
      if (method === 'DELETE' && delFile) {
        const sb = sandboxes.get(delFile[1]!)
        if (!sb) return errorJson(404, 'not_found', 'Sandbox not found')
        const filePath = url.searchParams.get('path') ?? ''
        const key = `${sb.sandbox_id}:${filePath}`
        files.delete(key)
        return json({ ok: true })
      }

      // POST /v1/sandboxes/:id/artifacts
      const postArtifacts = path.match(/^\/v1\/sandboxes\/(sb_\w+)\/artifacts$/)
      if (method === 'POST' && postArtifacts) {
        const sb = sandboxes.get(postArtifacts[1]!)
        if (!sb) return errorJson(404, 'not_found', 'Sandbox not found')
        const body = (await req.json()) as { paths: string[] }
        const existing = artifacts.get(sb.sandbox_id) ?? []
        const newPaths = body.paths.filter((p) => !existing.includes(p))
        existing.push(...newPaths)
        artifacts.set(sb.sandbox_id, existing)
        return json({ registered: newPaths.length, total: existing.length })
      }

      // GET /v1/sandboxes/:id/artifacts
      const getArtifacts = path.match(/^\/v1\/sandboxes\/(sb_\w+)\/artifacts$/)
      if (method === 'GET' && getArtifacts) {
        const sb = sandboxes.get(getArtifacts[1]!)
        if (!sb) return errorJson(404, 'not_found', 'Sandbox not found')
        const paths = artifacts.get(sb.sandbox_id) ?? []
        return json({
          artifacts: paths.map((p, i) => ({
            id: `art_${i}`,
            name: p,
            mime: 'application/octet-stream',
            bytes: 0,
            sha256: 'mock',
            download_url: `https://example.com/artifacts/art_${i}`,
            exec_id: null,
            created_at: new Date().toISOString(),
          })),
          next_cursor: null,
        })
      }

      return errorJson(404, 'not_found', `No route: ${method} ${path}`)
    },
  })

  return { server, sandboxes, execs, sessions, files, artifacts }
}

// ---------------------------------------------------------------------------
// E2E tests using the real SDK against the mock server
// ---------------------------------------------------------------------------

let mock: ReturnType<typeof createMockServer>
let client: Sandchest

beforeAll(() => {
  mock = createMockServer()
  client = new Sandchest({
    apiKey: 'sk_test_e2e',
    baseUrl: `http://localhost:${mock.server.port}`,
    retries: 0,
    timeout: 5000,
  })
})

afterAll(() => {
  mock.server.stop()
})

describe('SDK E2E: full sandbox lifecycle', () => {
  test('create sandbox and verify it returns a running Sandbox instance', async () => {
    const sandbox = await client.create({ env: { NODE_ENV: 'test' } })

    expect(sandbox).toBeInstanceOf(Sandbox)
    expect(sandbox.id).toMatch(/^sb_/)
    expect(sandbox.status).toBe('running')
    expect(sandbox.replayUrl).toContain(sandbox.id)
  })

  test('create sandbox with custom options', async () => {
    const sandbox = await client.create({
      image: 'node:20',
      profile: 'medium',
      env: { MY_VAR: 'hello' },
      ttlSeconds: 7200,
      waitReady: false,
    })

    expect(sandbox).toBeInstanceOf(Sandbox)
    expect(sandbox.id).toMatch(/^sb_/)
  })

  test('get sandbox by ID', async () => {
    const created = await client.create()
    const fetched = await client.get(created.id)

    expect(fetched).toBeInstanceOf(Sandbox)
    expect(fetched.id).toBe(created.id)
    expect(fetched.status).toBe('running')
  })

  test('list sandboxes returns all created sandboxes', async () => {
    const sandboxes = await client.list()
    expect(sandboxes.length).toBeGreaterThan(0)
    expect(sandboxes[0]).toBeInstanceOf(Sandbox)
  })

  test('list sandboxes with status filter', async () => {
    const created = await client.create()
    await created.stop()

    const running = await client.list({ status: 'running' })
    const stopping = await client.list({ status: 'stopping' })

    const runningIds = running.map((s) => s.id)
    const stoppingIds = stopping.map((s) => s.id)

    expect(runningIds).not.toContain(created.id)
    expect(stoppingIds).toContain(created.id)
  })
})

describe('SDK E2E: exec', () => {
  test('blocking exec returns result with stdout', async () => {
    const sandbox = await client.create()
    const result = await sandbox.exec(['echo', 'hello world'])

    expect(result.execId).toMatch(/^ex_/)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('echo hello world')
    expect(result.stderr).toBe('')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('exec with string command', async () => {
    const sandbox = await client.create()
    const result = await sandbox.exec('ls -la')

    expect(result.execId).toMatch(/^ex_/)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('ls -la')
  })

  test('streaming exec returns ExecStream with events', async () => {
    const sandbox = await client.create()
    const stream = await sandbox.exec('echo streaming', { stream: true })

    expect(stream.execId).toMatch(/^ex_/)

    const result = await stream.collect()
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBeTruthy()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('streaming exec can be iterated', async () => {
    const sandbox = await client.create()
    const stream = await sandbox.exec('echo iterate', { stream: true })

    const events: unknown[] = []
    for await (const event of stream) {
      events.push(event)
    }

    expect(events.length).toBeGreaterThan(0)
    const types = events.map((e) => (e as { t: string }).t)
    expect(types).toContain('stdout')
    expect(types).toContain('exit')
  })

  test('exec with callbacks receives stdout/stderr', async () => {
    const sandbox = await client.create()
    const stdoutChunks: string[] = []

    const result = await sandbox.exec(['echo', 'callback test'], {
      onStdout: (data) => stdoutChunks.push(data),
    })

    expect(result.exitCode).toBe(0)
    expect(stdoutChunks.length).toBeGreaterThan(0)
    expect(stdoutChunks.join('')).toContain('echo callback test')
  })
})

describe('SDK E2E: fork', () => {
  test('fork creates a new sandbox linked to parent', async () => {
    const parent = await client.create()
    const child = await parent.fork()

    expect(child).toBeInstanceOf(Sandbox)
    expect(child.id).toMatch(/^sb_/)
    expect(child.id).not.toBe(parent.id)
    expect(child.status).toBe('running')
  })

  test('fork with env override', async () => {
    const parent = await client.create({ env: { A: '1' } })
    const child = await parent.fork({ env: { B: '2' } })

    expect(child.id).not.toBe(parent.id)
  })

  test('forks() returns fork tree', async () => {
    const parent = await client.create()
    const child1 = await parent.fork()
    const child2 = await parent.fork()

    const tree = await parent.forks()

    expect(tree.root).toBe(parent.id)
    expect(tree.tree.length).toBe(2)
    const childIds = tree.tree.map((n) => n.sandbox_id)
    expect(childIds).toContain(child1.id)
    expect(childIds).toContain(child2.id)
  })
})

describe('SDK E2E: sessions', () => {
  test('create and exec in session', async () => {
    const sandbox = await client.create()
    const session = await sandbox.session.create({ shell: '/bin/bash' })

    expect(session).toBeInstanceOf(Session)
    expect(session.id).toMatch(/^sess_/)

    const result = await session.exec('whoami')

    expect(result.execId).toMatch(/^ex_/)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('whoami')
  })

  test('destroy session', async () => {
    const sandbox = await client.create()
    const session = await sandbox.session.create()

    await session.destroy()
    // Session destroy should not throw
  })
})

describe('SDK E2E: file operations', () => {
  test('upload and download file round-trip', async () => {
    const sandbox = await client.create()
    const content = new TextEncoder().encode('hello from SDK E2E test')

    await sandbox.fs.upload('/work/test.txt', content)

    const downloaded = await sandbox.fs.download('/work/test.txt')
    expect(new TextDecoder().decode(downloaded)).toBe('hello from SDK E2E test')
  })

  test('upload binary data preserves bytes', async () => {
    const sandbox = await client.create()
    const binary = new Uint8Array([0, 1, 2, 127, 128, 254, 255])

    await sandbox.fs.upload('/data/binary.bin', binary)

    const downloaded = await sandbox.fs.download('/data/binary.bin')
    expect(downloaded).toEqual(binary)
  })

  test('list files in directory', async () => {
    const sandbox = await client.create()
    await sandbox.fs.upload('/work/a.txt', new TextEncoder().encode('a'))

    const files = await sandbox.fs.ls('/work')
    expect(files).toBeArray()
  })

  test('delete file', async () => {
    const sandbox = await client.create()
    await sandbox.fs.upload('/tmp/delete-me.txt', new TextEncoder().encode('bye'))

    await sandbox.fs.rm('/tmp/delete-me.txt')
    // Delete should not throw
  })
})

describe('SDK E2E: artifacts', () => {
  test('register and list artifacts', async () => {
    const sandbox = await client.create()

    const result = await sandbox.artifacts.register(['/output/result.json', '/output/log.txt'])
    expect(result.registered).toBe(2)
    expect(result.total).toBe(2)

    const listed = await sandbox.artifacts.list()
    expect(listed.length).toBe(2)
    expect(listed[0]!.name).toBe('/output/result.json')
    expect(listed[1]!.name).toBe('/output/log.txt')
  })

  test('registering duplicates is idempotent', async () => {
    const sandbox = await client.create()

    await sandbox.artifacts.register(['/a.txt'])
    const result = await sandbox.artifacts.register(['/a.txt', '/b.txt'])

    expect(result.registered).toBe(1)
    expect(result.total).toBe(2)
  })
})

describe('SDK E2E: lifecycle', () => {
  test('stop sandbox transitions to stopping', async () => {
    const sandbox = await client.create()
    expect(sandbox.status).toBe('running')

    await sandbox.stop()
    expect(sandbox.status).toBe('stopping')
  })

  test('destroy sandbox transitions to deleted', async () => {
    const sandbox = await client.create()
    await sandbox.destroy()
    expect(sandbox.status).toBe('deleted')
  })

  test('exec on stopped sandbox throws SandboxNotRunningError', async () => {
    const sandbox = await client.create()
    await sandbox.stop()

    expect(sandbox.exec('echo fail')).rejects.toThrow(SandboxNotRunningError)
  })

  test('session create on stopped sandbox throws SandboxNotRunningError', async () => {
    const sandbox = await client.create()
    await sandbox.stop()

    expect(sandbox.session.create()).rejects.toThrow(SandboxNotRunningError)
  })

  test('file upload on stopped sandbox throws SandboxNotRunningError', async () => {
    const sandbox = await client.create()
    await sandbox.stop()

    expect(
      sandbox.fs.upload('/test.txt', new TextEncoder().encode('fail')),
    ).rejects.toThrow(SandboxNotRunningError)
  })

  test('fork on stopped sandbox throws SandboxNotRunningError', async () => {
    const sandbox = await client.create()
    await sandbox.stop()

    expect(sandbox.fork()).rejects.toThrow(SandboxNotRunningError)
  })
})

describe('SDK E2E: error handling', () => {
  test('get non-existent sandbox throws NotFoundError', async () => {
    expect(client.get('sb_nonexistent')).rejects.toThrow(NotFoundError)
  })

  test('invalid API key throws AuthenticationError', async () => {
    const badClient = new Sandchest({
      apiKey: 'sk_invalid',
      baseUrl: `http://localhost:${mock.server.port}`,
      retries: 0,
    })

    expect(badClient.create()).rejects.toThrow(AuthenticationError)
  })
})

describe('SDK E2E: full workflow integration', () => {
  test('complete sandbox lifecycle: create → exec → fork → session → file → artifacts → stop', async () => {
    // 1. Create sandbox
    const sandbox = await client.create({ env: { NODE_ENV: 'test' } })
    expect(sandbox.status).toBe('running')

    // 2. Execute a command
    const execResult = await sandbox.exec(['echo', 'hello'])
    expect(execResult.exitCode).toBe(0)

    // 3. Upload a file
    const fileContent = new TextEncoder().encode('test data')
    await sandbox.fs.upload('/work/data.txt', fileContent)

    // 4. Download the file
    const downloaded = await sandbox.fs.download('/work/data.txt')
    expect(new TextDecoder().decode(downloaded)).toBe('test data')

    // 5. Register artifacts
    const artifacts = await sandbox.artifacts.register(['/work/data.txt'])
    expect(artifacts.registered).toBe(1)

    // 6. Create a session and exec in it
    const session = await sandbox.session.create()
    const sessResult = await session.exec('pwd')
    expect(sessResult.exitCode).toBe(0)
    await session.destroy()

    // 7. Fork the sandbox
    const forked = await sandbox.fork()
    expect(forked.status).toBe('running')

    // 8. Exec in the fork
    const forkExec = await forked.exec('echo forked')
    expect(forkExec.exitCode).toBe(0)

    // 9. Stop the fork
    await forked.stop()
    expect(forked.status).toBe('stopping')

    // 10. Stop the original
    await sandbox.stop()
    expect(sandbox.status).toBe('stopping')
  })
})
