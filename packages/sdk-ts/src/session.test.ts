import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { Session } from './session.js'
import { HttpClient } from './http.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('Session', () => {
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

  test('stores id, sandboxId, and http client', () => {
    const http = createMockHttp()
    const session = new Session('sess_abc', 'sb_xyz', http)

    expect(session.id).toBe('sess_abc')
    expect(session._sandboxId).toBe('sb_xyz')
    expect(session._http).toBe(http)
  })

  describe('exec', () => {
    test('sends POST to /v1/sandboxes/:id/sessions/:sessionId/exec', async () => {
      let capturedUrl = ''
      let capturedBody = ''
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url)
        capturedBody = init?.body as string
        return jsonResponse({
          exec_id: 'ex_sess1',
          status: 'done',
          exit_code: 0,
          stdout: 'output\n',
          stderr: '',
          duration_ms: 15,
          resource_usage: { cpu_ms: 5, peak_memory_bytes: 512 },
        })
      }) as unknown as typeof fetch

      const session = new Session('sess_abc', 'sb_xyz', createMockHttp())
      const result = await session.exec('pwd')

      expect(capturedUrl).toBe(
        'https://api.sandchest.com/v1/sandboxes/sb_xyz/sessions/sess_abc/exec',
      )
      const body = JSON.parse(capturedBody)
      expect(body.cmd).toBe('pwd')
      expect(body.wait).toBe(true)
      expect(result.execId).toBe('ex_sess1')
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('output\n')
      expect(result.stderr).toBe('')
      expect(result.durationMs).toBe(15)
    })

    test('passes timeout option as timeout_seconds', async () => {
      let capturedBody = ''
      globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string
        return jsonResponse({
          exec_id: 'ex_sess2',
          status: 'done',
          exit_code: 0,
          stdout: '',
          stderr: '',
          duration_ms: 5,
          resource_usage: { cpu_ms: 2, peak_memory_bytes: 256 },
        })
      }) as unknown as typeof fetch

      const session = new Session('sess_abc', 'sb_xyz', createMockHttp())
      await session.exec('sleep 5', { timeout: 30 })

      const body = JSON.parse(capturedBody)
      expect(body.timeout_seconds).toBe(30)
    })
  })

  describe('destroy', () => {
    test('sends DELETE to /v1/sandboxes/:id/sessions/:sessionId', async () => {
      let capturedUrl = ''
      let capturedMethod = ''
      globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url)
        capturedMethod = init?.method ?? ''
        return jsonResponse({ ok: true })
      }) as unknown as typeof fetch

      const session = new Session('sess_abc', 'sb_xyz', createMockHttp())
      await session.destroy()

      expect(capturedUrl).toBe(
        'https://api.sandchest.com/v1/sandboxes/sb_xyz/sessions/sess_abc',
      )
      expect(capturedMethod).toBe('DELETE')
    })
  })
})
