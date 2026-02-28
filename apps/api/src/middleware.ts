import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { timingSafeEqual } from 'node:crypto'
import { parseScopes } from '@sandchest/contract'
import { UnauthorizedError, formatApiError } from './errors.js'
import { AuthContext } from './context.js'
import { auth } from './auth.js'
import { loadEnv } from './env.js'

/**
 * Generates a request ID (or propagates from X-Request-Id header)
 * and attaches it to the response.
 */
export const withRequestId = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const incoming = request.headers['x-request-id']
    const requestId = incoming ?? crypto.randomUUID()
    const response = yield* app
    return response.pipe(HttpServerResponse.setHeader('x-request-id', requestId))
  }),
)

/**
 * Validates API key or session cookie and provides AuthContext.
 * Skips auth for /health, /healthz, /readyz, /api/auth/*, /v1/public/*, and /v1/internal/* routes.
 *
 * API keys carry optional scopes via metadata.scopes. Keys without scopes
 * are treated as full-access (backward compatible). Session auth always gets full access.
 */
export const withAuth = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest

    if (request.url.startsWith('/health') || request.url.startsWith('/readyz') || request.url.startsWith('/api/auth') || request.url.startsWith('/v1/public/') || request.url.startsWith('/v1/internal/') || request.url === '/openapi.json' || request.url === '/docs') {
      return yield* Effect.provideService(app, AuthContext, { userId: '', orgId: '', scopes: null })
    }

    // Admin API routes: validate static bearer token
    if (request.url.startsWith('/v1/admin/')) {
      const env = loadEnv()
      const adminToken = env.ADMIN_API_TOKEN
      if (!adminToken) {
        return formatApiError(new UnauthorizedError({ message: 'Admin API not configured' }))
      }
      const authHeader = request.headers['authorization']
      const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : ''
      if (!provided || provided.length !== adminToken.length) {
        return formatApiError(new UnauthorizedError({ message: 'Invalid admin token' }))
      }
      const a = new TextEncoder().encode(provided)
      const b = new TextEncoder().encode(adminToken)
      if (!timingSafeEqual(a, b)) {
        return formatApiError(new UnauthorizedError({ message: 'Invalid admin token' }))
      }
      return yield* Effect.provideService(app, AuthContext, { userId: 'admin', orgId: '', scopes: null })
    }

    const authHeader = request.headers['authorization']
    if (authHeader?.startsWith('Bearer ')) {
      const key = authHeader.slice(7)
      const result = yield* Effect.tryPromise({
        try: () => auth.api.verifyApiKey({ body: { key } }),
        catch: () => new UnauthorizedError({ message: 'Invalid API key' }),
      }).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
      )

      if (!result?.valid) {
        return formatApiError(new UnauthorizedError({ message: 'Invalid API key' }))
      }

      const metadata = (result as { metadata?: { orgId?: string; scopes?: string[] } }).metadata
      const rawScopes = metadata?.scopes
      const scopes = Array.isArray(rawScopes) ? parseScopes(rawScopes) : null

      return yield* Effect.provideService(app, AuthContext, {
        userId: (result as { userId?: string }).userId ?? '',
        orgId: metadata?.orgId ?? '',
        scopes,
      })
    }

    const sessionResult = yield* Effect.tryPromise({
      try: () =>
        auth.api.getSession({
          headers: new Headers(request.headers as Record<string, string>),
        }),
      catch: () => new UnauthorizedError({ message: 'Invalid session' }),
    }).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    )

    if (!sessionResult?.session) {
      return formatApiError(new UnauthorizedError({ message: 'Authentication required' }))
    }

    return yield* Effect.provideService(app, AuthContext, {
      userId: sessionResult.session.userId,
      orgId:
        (sessionResult.session as { activeOrganizationId?: string }).activeOrganizationId ?? '',
      scopes: null,
    })
  }),
)
