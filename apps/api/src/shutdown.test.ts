import { Effect, Fiber } from 'effect'
import { describe, expect, test } from 'bun:test'
import { ShutdownControllerLive, ShutdownController } from './shutdown.js'

function runWithShutdown<A>(effect: Effect.Effect<A, unknown, ShutdownController>) {
  return effect.pipe(Effect.provide(ShutdownControllerLive), Effect.runPromise)
}

describe('ShutdownController', () => {
  test('starts in non-draining state', async () => {
    const result = await runWithShutdown(
      Effect.gen(function* () {
        const shutdown = yield* ShutdownController
        return yield* shutdown.isDraining
      }),
    )

    expect(result).toBe(false)
  })

  test('starts with zero active connections', async () => {
    const result = await runWithShutdown(
      Effect.gen(function* () {
        const shutdown = yield* ShutdownController
        return yield* shutdown.connectionCount
      }),
    )

    expect(result).toBe(0)
  })

  test('trackConnection increments and decrements count', async () => {
    const result = await runWithShutdown(
      Effect.gen(function* () {
        const shutdown = yield* ShutdownController

        const release1 = yield* shutdown.trackConnection
        const release2 = yield* shutdown.trackConnection
        const during = yield* shutdown.connectionCount

        yield* release1
        const afterOne = yield* shutdown.connectionCount

        yield* release2
        const afterAll = yield* shutdown.connectionCount

        return { during, afterOne, afterAll }
      }),
    )

    expect(result.during).toBe(2)
    expect(result.afterOne).toBe(1)
    expect(result.afterAll).toBe(0)
  })

  test('beginDrain sets draining to true', async () => {
    const result = await runWithShutdown(
      Effect.gen(function* () {
        const shutdown = yield* ShutdownController
        yield* shutdown.beginDrain
        return yield* shutdown.isDraining
      }),
    )

    expect(result).toBe(true)
  })

  test('awaitDrained resolves immediately when no connections', async () => {
    const result = await runWithShutdown(
      Effect.gen(function* () {
        const shutdown = yield* ShutdownController
        yield* shutdown.beginDrain
        yield* shutdown.awaitDrained
        return true
      }),
    )

    expect(result).toBe(true)
  })

  test('awaitDrained resolves after last connection releases', async () => {
    const result = await runWithShutdown(
      Effect.gen(function* () {
        const shutdown = yield* ShutdownController
        const release = yield* shutdown.trackConnection

        // Begin drain while connection is active
        yield* shutdown.beginDrain

        // Fork awaitDrained to run concurrently
        const fiber = yield* Effect.fork(
          shutdown.awaitDrained.pipe(Effect.as('drained')),
        )

        // Release the connection — this should unblock awaitDrained
        yield* release

        return yield* Fiber.join(fiber)
      }),
    )

    expect(result).toBe('drained')
  })
})
