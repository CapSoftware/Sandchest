import {
  NotFoundError,
  Sandchest,
  type Sandbox,
  type Session,
} from '../../sdk-ts/dist/index.js'

const DEFAULT_BASE_URL = 'https://api.sandchest.com'
const DEFAULT_TTL_SECONDS = 600
const VALID_PROFILES = ['small', 'medium', 'large'] as const

export type SmokeProfile = (typeof VALID_PROFILES)[number]

export interface SandboxSmokeLogger {
  info?(message: string): void
  step?(label: string, message: string): void
  warn?(message: string): void
}

export interface SandboxSmokeOptions {
  apiKey: string
  baseUrl?: string | undefined
  image?: string | undefined
  profile?: SmokeProfile | undefined
  ttlSeconds?: number | undefined
  logger?: SandboxSmokeLogger | undefined
}

export interface ResolvedSandboxSmokeOptions {
  apiKey: string
  baseUrl: string
  image?: string | undefined
  profile: SmokeProfile
  ttlSeconds: number
}

export interface SandboxSmokeCheckResult {
  name: string
  durationMs: number
}

export interface SandboxSmokeResult {
  runId: string
  baseUrl: string
  rootSandboxId: string
  forkSandboxId: string
  checks: SandboxSmokeCheckResult[]
}

export interface CleanupFailure {
  kind: 'sandbox' | 'session'
  label: string
  id: string
  error: Error
}

type CleanupTask = {
  kind: CleanupFailure['kind']
  label: string
  id: string
  destroy: () => Promise<void>
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error
  }
  return new Error(String(error))
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

function assertExecSuccess(
  result: { exitCode: number; stdout: string; stderr: string },
  context: string,
): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${context} failed with exit ${result.exitCode}: ${result.stderr || '(no stderr)'}`,
    )
  }
}

function formatCleanupFailure(failure: CleanupFailure): string {
  return `${failure.kind} ${failure.label} (${failure.id}): ${failure.error.message}`
}

function makeRunId(): string {
  return `admin-smoke-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
}

async function measureCheck(
  name: string,
  logger: SandboxSmokeLogger | undefined,
  fn: () => Promise<void>,
): Promise<SandboxSmokeCheckResult> {
  logger?.step?.('check', name)
  const startedAt = Date.now()
  await fn()
  const durationMs = Date.now() - startedAt
  logger?.info?.(`${name} (${durationMs}ms)`)
  return { name, durationMs }
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
}

function normalizeProfile(profile: string | undefined): SmokeProfile {
  const value = (profile || 'small') as SmokeProfile
  if (!VALID_PROFILES.includes(value)) {
    throw new Error(
      `Invalid profile '${profile}'. Expected one of: ${VALID_PROFILES.join(', ')}`,
    )
  }
  return value
}

function normalizeTtlSeconds(ttlSeconds: number | undefined): number {
  const value = ttlSeconds ?? DEFAULT_TTL_SECONDS
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('ttlSeconds must be a positive integer')
  }
  return value
}

export function resolveSandboxSmokeOptions(
  options: Partial<SandboxSmokeOptions>,
  defaults?: { baseUrl?: string | undefined },
): ResolvedSandboxSmokeOptions {
  const apiKey = options.apiKey?.trim() || process.env['SANDCHEST_API_KEY']?.trim()
  if (!apiKey) {
    throw new Error('Missing API key. Pass --api-key or set SANDCHEST_API_KEY.')
  }

  return {
    apiKey,
    baseUrl: normalizeBaseUrl(options.baseUrl || defaults?.baseUrl),
    image: options.image,
    profile: normalizeProfile(options.profile),
    ttlSeconds: normalizeTtlSeconds(options.ttlSeconds),
  }
}

export class SandboxSmokeTracker {
  private readonly sandboxes: CleanupTask[] = []
  private readonly sessions: CleanupTask[] = []

  trackSandbox(label: string, sandbox: Pick<Sandbox, 'id' | 'destroy'>): void {
    this.sandboxes.push({
      kind: 'sandbox',
      label,
      id: sandbox.id,
      destroy: () => sandbox.destroy(),
    })
  }

  trackSession(label: string, session: Pick<Session, 'id' | 'destroy'>): void {
    this.sessions.push({
      kind: 'session',
      label,
      id: session.id,
      destroy: () => session.destroy(),
    })
  }

  releaseSession(sessionId: string): void {
    const index = this.sessions.findIndex((entry) => entry.id === sessionId)
    if (index >= 0) {
      this.sessions.splice(index, 1)
    }
  }

  async cleanup(logger?: SandboxSmokeLogger): Promise<CleanupFailure[]> {
    const failures: CleanupFailure[] = []
    const tasks = [...this.sessions.slice().reverse(), ...this.sandboxes.slice().reverse()]

    for (const task of tasks) {
      try {
        logger?.step?.('cleanup', `${task.kind} ${task.label} (${task.id})`)
        await task.destroy()
      } catch (error) {
        if (error instanceof NotFoundError) {
          continue
        }
        const normalized = toError(error)
        logger?.warn?.(`Cleanup failed for ${task.kind} ${task.label} (${task.id}): ${normalized.message}`)
        failures.push({
          kind: task.kind,
          label: task.label,
          id: task.id,
          error: normalized,
        })
      }
    }

    return failures
  }
}

export async function runSandboxSmokeTest(
  options: SandboxSmokeOptions,
): Promise<SandboxSmokeResult> {
  const resolved = resolveSandboxSmokeOptions(options)
  const logger = options.logger
  const client = new Sandchest({
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    timeout: 60_000,
    retries: 1,
  })
  const tracker = new SandboxSmokeTracker()
  const checks: SandboxSmokeCheckResult[] = []
  const runId = makeRunId()
  const sharedPath = `/work/${runId}.txt`
  const sessionPath = `/work/${runId}.session.txt`
  const fileContents = `smoke:${runId}`

  let rootSandboxId = ''
  let forkSandboxId = ''
  let primaryError: Error | undefined

  try {
    let rootSandbox: Sandbox | undefined
    checks.push(
      await measureCheck('create sandbox', logger, async () => {
        rootSandbox = await client.create({
          image: resolved.image,
          profile: resolved.profile,
          ttlSeconds: resolved.ttlSeconds,
          env: {
            SANDCHEST_SMOKE_RUN: runId,
          },
        })
        tracker.trackSandbox('root', rootSandbox)
        rootSandboxId = rootSandbox.id
        assert(rootSandbox.status === 'running', `Expected running sandbox, got ${rootSandbox.status}`)
      }),
    )

    assert(rootSandbox, 'Sandbox was not created')
    const sandbox = rootSandbox

    checks.push(
      await measureCheck('lookup sandbox', logger, async () => {
        const fetched = await client.get(sandbox.id)
        assert(fetched.id === sandbox.id, 'client.get returned the wrong sandbox id')

        const runningSandboxes = await client.list({ status: 'running' })
        assert(
          runningSandboxes.some((listedSandbox: { id: string }) => listedSandbox.id === sandbox.id),
          `client.list did not include sandbox ${sandbox.id}`,
        )
      }),
    )

    checks.push(
      await measureCheck('exec command', logger, async () => {
        const execResult = await sandbox.exec(
          ['sh', '-lc', 'test "$SANDCHEST_SMOKE_RUN" = "$EXPECTED" && printf smoke-ok'],
          { env: { EXPECTED: runId }, timeout: 60 },
        )
        assertExecSuccess(execResult, 'sandbox exec')
        assert(execResult.stdout === 'smoke-ok', `Unexpected exec stdout: ${JSON.stringify(execResult.stdout)}`)
      }),
    )

    checks.push(
      await measureCheck('file operations', logger, async () => {
        await sandbox.fs.write(sharedPath, fileContents)
        const fileValue = await sandbox.fs.read(sharedPath)
        assert(fileValue === fileContents, 'sandbox.fs.read did not match written content')

        const files = await sandbox.fs.ls('/work')
        assert(
          files.some((entry: { path: string }) => entry.path === sharedPath),
          `sandbox.fs.ls did not include ${sharedPath}`,
        )
      }),
    )

    checks.push(
      await measureCheck('artifact registration', logger, async () => {
        const registered = await sandbox.artifacts.register([sharedPath])
        assert(registered.registered >= 1, 'artifact registration returned zero registered artifacts')

        const artifacts = await sandbox.artifacts.list()
        assert(
          artifacts.some((artifact: { name: string }) => artifact.name === sharedPath),
          `artifact list did not include ${sharedPath}`,
        )
      }),
    )

    checks.push(
      await measureCheck('session lifecycle', logger, async () => {
        const session = await sandbox.session.create({ shell: '/bin/bash' })
        tracker.trackSession('root-shell', session)

        const primeResult = await session.exec(
          `cd /work && printf '%s' "session:${runId}" > "${sessionPath}"`,
          { timeout: 60 },
        )
        assertExecSuccess(primeResult, 'session prime exec')

        const persistedResult = await session.exec(`pwd && cat "${sessionPath}"`, { timeout: 60 })
        assertExecSuccess(persistedResult, 'session persisted exec')

        const output = persistedResult.stdout.trimEnd()
        assert(
          output === `/work\nsession:${runId}`,
          `Session state did not persist as expected: ${JSON.stringify(output)}`,
        )

        await session.destroy()
        tracker.releaseSession(session.id)
      }),
    )

    let forkSandbox: Sandbox | undefined
    checks.push(
      await measureCheck('fork sandbox', logger, async () => {
        forkSandbox = await sandbox.fork({
          env: { SANDCHEST_SMOKE_FORK: runId },
          ttlSeconds: resolved.ttlSeconds,
        })
        tracker.trackSandbox('fork', forkSandbox)
        forkSandboxId = forkSandbox.id

        const forkReadback = await forkSandbox.fs.read(sharedPath)
        assert(forkReadback === fileContents, 'Fork did not inherit parent filesystem state')

        const forkExec = await forkSandbox.exec(
          ['sh', '-lc', 'test "$SANDCHEST_SMOKE_FORK" = "$EXPECTED" && printf fork-ok'],
          { env: { EXPECTED: runId }, timeout: 60 },
        )
        assertExecSuccess(forkExec, 'fork exec')
        assert(forkExec.stdout === 'fork-ok', `Unexpected fork stdout: ${JSON.stringify(forkExec.stdout)}`)

        const forkTree = await sandbox.forks()
        assert(
          forkTree.tree.some(
            (node: { sandbox_id: string }) => node.sandbox_id === forkSandbox!.id,
          ),
          `Fork tree did not include ${forkSandbox.id}`,
        )
      }),
    )

    assert(forkSandbox, 'Fork sandbox was not created')
    const fork = forkSandbox

    checks.push(
      await measureCheck('stop fork', logger, async () => {
        await fork.stop()
        assert(
          fork.status === 'stopping' || fork.status === 'stopped',
          `Expected fork to be stopping or stopped, got ${fork.status}`,
        )

        const fetched = await client.get(fork.id)
        assert(
          fetched.status === 'stopping' || fetched.status === 'stopped',
          `Expected fetched fork to be stopping or stopped, got ${fetched.status}`,
        )
      }),
    )
  } catch (error) {
    primaryError = toError(error)
  }

  const cleanupFailures = await tracker.cleanup(logger)

  if (primaryError && cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupFailures.map((failure) => failure.error)],
      `Sandbox smoke test failed and cleanup left errors: ${cleanupFailures.map(formatCleanupFailure).join('; ')}`,
    )
  }

  if (primaryError) {
    throw primaryError
  }

  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      cleanupFailures.map((failure) => failure.error),
      `Sandbox smoke cleanup failed: ${cleanupFailures.map(formatCleanupFailure).join('; ')}`,
    )
  }

  assert(rootSandboxId, 'Missing root sandbox id in smoke result')
  assert(forkSandboxId, 'Missing fork sandbox id in smoke result')

  return {
    runId,
    baseUrl: resolved.baseUrl,
    rootSandboxId,
    forkSandboxId,
    checks,
  }
}
