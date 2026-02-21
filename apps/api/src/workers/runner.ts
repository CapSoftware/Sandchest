import { Effect, type Fiber, Schedule, Duration, type Scope } from 'effect'
import { RedisService } from '../services/redis.js'

export interface WorkerConfig<R> {
  readonly name: string
  readonly intervalMs: number
  readonly handler: Effect.Effect<number, never, R>
}

const generateInstanceId = (): string =>
  `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

/**
 * Run a single worker tick: acquire leader lock, execute handler if leader.
 * Returns the handler result count, or -1 if not leader.
 */
export function runWorkerTick<R>(
  config: WorkerConfig<R>,
  instanceId: string,
): Effect.Effect<number, never, R | RedisService> {
  const ttlMs = config.intervalMs * 2

  return Effect.gen(function* () {
    const redis = yield* RedisService
    const isLeader = yield* redis.acquireLeaderLock(config.name, instanceId, ttlMs)
    if (!isLeader) return -1

    const count = yield* config.handler
    return count
  })
}

/**
 * Create a long-running fiber for a worker. The fiber repeatedly runs the
 * handler at the configured interval, with leader election gating execution.
 * Errors in the handler are caught and logged — they never crash the fiber.
 */
export function createWorkerFiber<R>(
  config: WorkerConfig<R>,
  instanceId: string,
): Effect.Effect<Fiber.RuntimeFiber<void, never>, never, R | RedisService | Scope.Scope> {
  const tick = runWorkerTick(config, instanceId).pipe(
    Effect.catchAllCause(() => Effect.succeed(-1)),
  )

  const loop = tick.pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(config.intervalMs))),
    Effect.asVoid,
  )

  return Effect.forkScoped(loop)
}

/**
 * Start all workers as scoped fibers. Returns an Effect that, when run in a
 * scope, launches all worker fibers.
 */
export function startWorkers<R>(
  configs: ReadonlyArray<WorkerConfig<R>>,
): Effect.Effect<Fiber.RuntimeFiber<void, never>[], never, R | RedisService | Scope.Scope> {
  const instanceId = generateInstanceId()

  return Effect.all(
    configs.map((config) => createWorkerFiber(config, instanceId)),
  )
}
