import { Context, Deferred, Effect, Layer, Ref } from 'effect'

export interface ShutdownState {
  readonly draining: boolean
  readonly activeConnections: number
}

export interface ShutdownApi {
  /** Returns true if the server is draining (shutting down). */
  readonly isDraining: Effect.Effect<boolean>
  /** Increment active connection count. Returns a finalizer to decrement. */
  readonly trackConnection: Effect.Effect<Effect.Effect<void>>
  /** Current number of in-flight connections. */
  readonly connectionCount: Effect.Effect<number>
  /** Signal that shutdown has begun. */
  readonly beginDrain: Effect.Effect<void>
  /** Resolves when active connections reach zero (or immediately if already zero). */
  readonly awaitDrained: Effect.Effect<void>
}

export class ShutdownController extends Context.Tag('ShutdownController')<
  ShutdownController,
  ShutdownApi
>() {}

export const ShutdownControllerLive = Layer.effect(
  ShutdownController,
  Effect.gen(function* () {
    const state = yield* Ref.make<ShutdownState>({ draining: false, activeConnections: 0 })
    const drained = yield* Deferred.make<void>()

    const checkDrained = Effect.gen(function* () {
      const { draining, activeConnections } = yield* Ref.get(state)
      if (draining && activeConnections === 0) {
        yield* Deferred.succeed(drained, undefined)
      }
    })

    return ShutdownController.of({
      isDraining: Ref.get(state).pipe(Effect.map((s) => s.draining)),

      trackConnection: Effect.gen(function* () {
        yield* Ref.update(state, (s) => ({ ...s, activeConnections: s.activeConnections + 1 }))
        return Ref.update(state, (s) => ({
          ...s,
          activeConnections: s.activeConnections - 1,
        })).pipe(Effect.tap(() => checkDrained))
      }),

      connectionCount: Ref.get(state).pipe(Effect.map((s) => s.activeConnections)),

      beginDrain: Effect.gen(function* () {
        yield* Ref.update(state, (s) => ({ ...s, draining: true }))
        yield* checkDrained
      }),

      awaitDrained: Deferred.await(drained),
    })
  }),
)
