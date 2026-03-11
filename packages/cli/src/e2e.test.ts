import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Sandchest } from '@sandchest/sdk'

const PROD_API_KEY = process.env['SANDCHEST_PROD_API_KEY']
const PROD_BASE_URL = 'https://api.sandchest.com'

const describeE2E = PROD_API_KEY ? describe : describe.skip

describeE2E('CLI E2E (prod)', () => {
  let client: Sandchest
  const sandboxIds: string[] = []

  async function cleanup() {
    for (const id of sandboxIds) {
      try {
        const sb = await client.get(id)
        if (sb.status !== 'deleted') {
          await sb.destroy()
        }
      } catch {
        // already gone
      }
    }
    sandboxIds.length = 0
  }

  beforeAll(() => {
    // Restore real fetch — test preload blocks network requests for unit tests,
    // but E2E tests need to hit the real API.
    const realFetch = (globalThis as Record<string, unknown>)['__sandchestRealFetch'] as typeof fetch | undefined
    if (realFetch) {
      globalThis.fetch = realFetch
    }

    client = new Sandchest({
      apiKey: PROD_API_KEY,
      baseUrl: PROD_BASE_URL,
      timeout: 120_000,
    })
  })

  afterAll(async () => {
    await cleanup()
  })

  // Ensure cleanup runs even if tests fail — use a long timeout
  // The last test in the suite handles cleanup; beforeAll can't register afterAll dynamically
  // so we rely on the explicit cleanup test at the end.

  test('create → exec → stop → destroy lifecycle', async () => {
    // CREATE
    const sandbox = await client.create({ ttlSeconds: 300 })
    sandboxIds.push(sandbox.id)

    expect(sandbox.id).toMatch(/^sb_/)
    expect(sandbox.status).toBe('running')
    expect(sandbox.replayUrl).toContain('sandchest.com')

    // EXEC — simple command
    const echo = await sandbox.exec('echo hello world')
    expect(echo.exitCode).toBe(0)
    expect(echo.stdout.trim()).toBe('hello world')
    expect(echo.execId).toMatch(/^ex_/)
    expect(echo.durationMs).toBeGreaterThan(0)

    // EXEC — command with exit code
    const failing = await sandbox.exec('exit 42')
    expect(failing.exitCode).toBe(42)

    // EXEC — stderr
    const stderrCmd = await sandbox.exec('echo oops >&2')
    expect(stderrCmd.stderr.trim()).toBe('oops')

    // EXEC — env vars
    const envCmd = await sandbox.exec('echo $MY_VAR', { env: { MY_VAR: 'test123' } })
    expect(envCmd.stdout.trim()).toBe('test123')

    // EXEC — working directory
    const cwdCmd = await sandbox.exec('pwd', { cwd: '/tmp' })
    expect(cwdCmd.stdout.trim()).toBe('/tmp')

    // STOP
    await sandbox.stop()
    const stopped = await client.get(sandbox.id)
    expect(['stopped', 'stopping']).toContain(stopped.status)

    // DESTROY
    await sandbox.destroy()
    sandboxIds.splice(sandboxIds.indexOf(sandbox.id), 1)
  }, 120_000)

  test('file upload and download', async () => {
    const sandbox = await client.create({ ttlSeconds: 300 })
    sandboxIds.push(sandbox.id)

    const content = 'Hello from E2E test\n'
    await sandbox.fs.write('/tmp/test.txt', content)

    const downloaded = await sandbox.fs.read('/tmp/test.txt')
    expect(downloaded).toBe(content)

    // Verify via exec
    const cat = await sandbox.exec('cat /tmp/test.txt')
    expect(cat.stdout).toBe(content)

    // List files
    const files = await sandbox.fs.ls('/tmp')
    const names = files.map((f) => f.name)
    expect(names).toContain('test.txt')

    // Remove file via exec (fs.rm not yet implemented in gRPC)
    await sandbox.exec('rm /tmp/test.txt')
    const catAfter = await sandbox.exec('cat /tmp/test.txt')
    expect(catAfter.exitCode).not.toBe(0)

    await sandbox.destroy()
    sandboxIds.splice(sandboxIds.indexOf(sandbox.id), 1)
  }, 120_000)

  // TODO: SSE stream returns empty stdout in prod — investigate event buffering
  test.skip('exec with streaming', async () => {
    const sandbox = await client.create({ ttlSeconds: 300 })
    sandboxIds.push(sandbox.id)

    // Use a longer-running command so the SSE stream connects before output finishes
    const stream = await sandbox.exec(
      'sleep 0.5 && echo "stream-start" && sleep 0.5 && echo "stream-end"',
      { stream: true },
    )

    const result = await stream.collect()
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('stream-start')
    expect(result.stdout).toContain('stream-end')

    await sandbox.destroy()
    sandboxIds.splice(sandboxIds.indexOf(sandbox.id), 1)
  }, 120_000)

  test('fork preserves state', async () => {
    const sandbox = await client.create({ ttlSeconds: 300 })
    sandboxIds.push(sandbox.id)

    // Write state in original
    await sandbox.exec('echo forked-data > /tmp/state.txt')

    // Fork
    const forked = await sandbox.fork({ ttlSeconds: 300 })
    sandboxIds.push(forked.id)

    expect(forked.id).toMatch(/^sb_/)
    expect(forked.id).not.toBe(sandbox.id)
    expect(forked.status).toBe('running')

    // Verify state was preserved
    const cat = await forked.exec('cat /tmp/state.txt')
    expect(cat.stdout.trim()).toBe('forked-data')

    // Verify fork tree
    const tree = await sandbox.forks()
    expect(tree.root).toBe(sandbox.id)
    const childIds = tree.tree.map((n) => n.sandbox_id)
    expect(childIds).toContain(forked.id)

    // Cleanup both
    await forked.destroy()
    sandboxIds.splice(sandboxIds.indexOf(forked.id), 1)
    await sandbox.destroy()
    sandboxIds.splice(sandboxIds.indexOf(sandbox.id), 1)
  }, 180_000)

  test('list sandboxes', async () => {
    const sandbox = await client.create({ ttlSeconds: 300 })
    sandboxIds.push(sandbox.id)

    const all = await client.list()
    const ids = all.map((s) => s.id)
    expect(ids).toContain(sandbox.id)

    // Filter by status
    const running = await client.list({ status: 'running' })
    const runningIds = running.map((s) => s.id)
    expect(runningIds).toContain(sandbox.id)

    await sandbox.destroy()
    sandboxIds.splice(sandboxIds.indexOf(sandbox.id), 1)
  }, 120_000)

})
