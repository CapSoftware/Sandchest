import { HttpClient, HttpClientRequest, HttpRouter, HttpServer, HttpServerResponse } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, test } from 'bun:test'
import { withConnectionDrain } from './connection-drain.js'
import { ShutdownController, ShutdownControllerLive } from '../shutdown.js'
import { RedisMemory } from '../services/redis.memory.js'

const TestRouter = HttpRouter.empty.pipe(
  HttpRouter.get(
    '/test',
    Effect.succeed(HttpServerResponse.unsafeJson({ ok: true })),
  ),
  HttpRouter.get(
    '/health',
    Effect.succeed(HttpServerResponse.unsafeJson({ status: 'ok' })),
  ),
)

const TestApp = TestRouter.pipe(withConnectionDrain, HttpServer.serve())

const TestLayer = TestApp.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(ShutdownControllerLive),
  Layer.provide(RedisMemory),
)

function runTest<A>(effect: Effect.Effect<A, unknown, HttpClient.HttpClient | ShutdownController>) {
  return effect.pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise)
}

describe('withConnectionDrain middleware', () => {
  test('passes requests through when not draining', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get('/test'))
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true })
  })

  test('returns 503 for non-probe requests when draining', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const shutdown = yield* ShutdownController
        yield* shutdown.beginDrain

        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get('/test'))
        const body = yield* response.json
        return {
          status: response.status,
          body,
          connection: response.headers['connection'],
        }
      }),
    )

    expect(result.status).toBe(503)
    const body = result.body as Record<string, unknown>
    expect(body.error).toBe('service_unavailable')
    expect(result.connection).toBe('close')
  })

  test('allows health probes through during drain', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const shutdown = yield* ShutdownController
        yield* shutdown.beginDrain

        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get('/health'))
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ status: 'ok' })
  })
})
