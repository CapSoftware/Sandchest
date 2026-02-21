import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerResponse,
} from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { describe, expect, test } from 'bun:test'
import { withSecurityHeaders, isAllowedOrigin } from './security-headers.js'

const TestRouter = HttpRouter.empty.pipe(
  HttpRouter.get(
    '/test',
    Effect.succeed(HttpServerResponse.unsafeJson({ ok: true })),
  ),
)

const AppLive = TestRouter.pipe(withSecurityHeaders, HttpServer.serve())

const TestLayer = AppLive.pipe(Layer.provideMerge(NodeHttpServer.layerTest))

function runTest<A>(effect: Effect.Effect<A, unknown, HttpClient.HttpClient>) {
  return effect.pipe(Effect.provide(TestLayer), Effect.scoped, Effect.runPromise)
}

// ---------------------------------------------------------------------------
// isAllowedOrigin
// ---------------------------------------------------------------------------

describe('isAllowedOrigin', () => {
  test('allows exact sandchest.com', () => {
    expect(isAllowedOrigin('https://sandchest.com')).toBe(true)
  })

  test('allows subdomains of sandchest.com', () => {
    expect(isAllowedOrigin('https://app.sandchest.com')).toBe(true)
    expect(isAllowedOrigin('https://staging.sandchest.com')).toBe(true)
    expect(isAllowedOrigin('https://my-test.sandchest.com')).toBe(true)
  })

  test('allows localhost with port', () => {
    expect(isAllowedOrigin('http://localhost:3000')).toBe(true)
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true)
    expect(isAllowedOrigin('http://localhost')).toBe(true)
  })

  test('rejects other origins', () => {
    expect(isAllowedOrigin('https://evil.com')).toBe(false)
    expect(isAllowedOrigin('https://notsandchest.com')).toBe(false)
    expect(isAllowedOrigin('https://sandchest.com.evil.com')).toBe(false)
    expect(isAllowedOrigin('http://sandchest.com')).toBe(false) // http, not https
  })

  test('rejects https localhost', () => {
    expect(isAllowedOrigin('https://localhost:3000')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// HSTS
// ---------------------------------------------------------------------------

describe('HSTS', () => {
  test('adds Strict-Transport-Security to all responses', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get('/test'))
        return {
          status: response.status,
          hsts: response.headers['strict-transport-security'],
        }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.hsts).toBe('max-age=63072000; includeSubDomains; preload')
  })
})

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

describe('CORS', () => {
  test('adds CORS headers when origin is allowed', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/test').pipe(
            HttpClientRequest.setHeader('origin', 'https://sandchest.com'),
          ),
        )
        return {
          status: response.status,
          allowOrigin: response.headers['access-control-allow-origin'],
          allowMethods: response.headers['access-control-allow-methods'],
          allowHeaders: response.headers['access-control-allow-headers'],
          exposeHeaders: response.headers['access-control-expose-headers'],
          allowCredentials: response.headers['access-control-allow-credentials'],
          vary: response.headers['vary'],
        }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.allowOrigin).toBe('https://sandchest.com')
    expect(result.allowMethods).toContain('GET')
    expect(result.allowHeaders).toContain('Authorization')
    expect(result.exposeHeaders).toContain('X-Request-Id')
    expect(result.allowCredentials).toBe('true')
    expect(result.vary).toBe('Origin')
  })

  test('does not add CORS headers for disallowed origin', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/test').pipe(
            HttpClientRequest.setHeader('origin', 'https://evil.com'),
          ),
        )
        return {
          status: response.status,
          allowOrigin: response.headers['access-control-allow-origin'],
          hsts: response.headers['strict-transport-security'],
        }
      }),
    )

    expect(result.status).toBe(200)
    expect(result.allowOrigin).toBeUndefined()
    expect(result.hsts).toBeDefined() // HSTS still present
  })

  test('does not add CORS headers when no origin', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(HttpClientRequest.get('/test'))
        return {
          allowOrigin: response.headers['access-control-allow-origin'],
        }
      }),
    )

    expect(result.allowOrigin).toBeUndefined()
  })

  test('handles OPTIONS preflight with allowed origin', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.options('/test').pipe(
            HttpClientRequest.setHeader('origin', 'http://localhost:3000'),
          ),
        )
        return {
          status: response.status,
          allowOrigin: response.headers['access-control-allow-origin'],
          allowMethods: response.headers['access-control-allow-methods'],
          maxAge: response.headers['access-control-max-age'],
          hsts: response.headers['strict-transport-security'],
        }
      }),
    )

    expect(result.status).toBe(204)
    expect(result.allowOrigin).toBe('http://localhost:3000')
    expect(result.allowMethods).toContain('GET')
    expect(result.maxAge).toBe('86400')
    expect(result.hsts).toBeDefined()
  })

  test('handles OPTIONS preflight with disallowed origin', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.options('/test').pipe(
            HttpClientRequest.setHeader('origin', 'https://evil.com'),
          ),
        )
        return {
          status: response.status,
          allowOrigin: response.headers['access-control-allow-origin'],
        }
      }),
    )

    expect(result.status).toBe(204)
    expect(result.allowOrigin).toBeUndefined()
  })

  test('adds CORS headers for subdomain origin', async () => {
    const result = await runTest(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient
        const response = yield* client.execute(
          HttpClientRequest.get('/test').pipe(
            HttpClientRequest.setHeader('origin', 'https://app.sandchest.com'),
          ),
        )
        return {
          allowOrigin: response.headers['access-control-allow-origin'],
        }
      }),
    )

    expect(result.allowOrigin).toBe('https://app.sandchest.com')
  })
})
