import { HttpClient, HttpClientRequest } from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, test } from 'bun:test'
import { AppLive } from './server.js'

const TestLayer = AppLive.pipe(Layer.provideMerge(NodeHttpServer.layerTest))

function runTest<A>(effect: Effect.Effect<A, unknown, HttpClient.HttpClient>) {
  return effect.pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise)
}

describe('Health endpoint', () => {
  test('GET /health returns 200 with status ok', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get('/health'))
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ status: 'ok' })
  })

  test('GET /health includes X-Request-Id header', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get('/health'))
        return response.headers['x-request-id']
      }),
    )

    expect(result).toBeDefined()
    expect(typeof result).toBe('string')
    expect(result!.length).toBeGreaterThan(0)
  })
})

describe('Route stubs', () => {
  test('POST /v1/sandboxes returns 501 not implemented', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.post('/v1/sandboxes'))
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(501)
    expect(result.body).toMatchObject({
      error: 'not_implemented',
      message: expect.stringContaining('not yet implemented'),
    })
  })

  test('GET /v1/sandboxes/:id returns 501 not implemented', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/v1/sandboxes/sb_test123'),
        )
        const body = yield* response.json
        return { status: response.status, body }
      }),
    )

    expect(result.status).toBe(501)
    expect(result.body).toMatchObject({ error: 'not_implemented' })
  })

  test('POST /v1/sandboxes/:id/exec returns 501', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes/sb_test123/exec'),
        )
        return response.status
      }),
    )

    expect(result).toBe(501)
  })

  test('POST /v1/sandboxes/:id/sessions returns 501', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.post('/v1/sandboxes/sb_test123/sessions'),
        )
        return response.status
      }),
    )

    expect(result).toBe(501)
  })
})

describe('Error response format', () => {
  test('error responses include standard envelope fields', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.post('/v1/sandboxes'))
        const body = (yield* response.json) as Record<string, unknown>
        return body
      }),
    )

    expect(result).toHaveProperty('error')
    expect(result).toHaveProperty('message')
    expect(result).toHaveProperty('request_id')
    expect(result).toHaveProperty('retry_after')
  })
})

describe('Request ID propagation', () => {
  test('echoes back provided X-Request-Id', async () => {
    const customId = 'req_test_12345'
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/health').pipe(
            HttpClientRequest.setHeader('x-request-id', customId),
          ),
        )
        return response.headers['x-request-id']
      }),
    )

    expect(result).toBe(customId)
  })
})
