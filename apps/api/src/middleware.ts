import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { UnauthorizedError } from './errors.js'
import { AuthContext } from './context.js'
import { auth } from './auth.js'

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
 * Skips auth for /health, /healthz, /readyz, and /api/auth/* routes.
 */
export const withAuth = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest

    if (request.url.startsWith('/health') || request.url.startsWith('/readyz') || request.url.startsWith('/api/auth')) {
      return yield* Effect.provideService(app, AuthContext, { userId: '', orgId: '' })
    }

    const authHeader = request.headers['authorization']
    if (authHeader?.startsWith('Bearer ')) {
      const key = authHeader.slice(7)
      const result = yield* Effect.tryPromise({
        try: () => auth.api.verifyApiKey({ body: { key } }),
        catch: () => new UnauthorizedError({ message: 'Invalid API key' }),
      })

      if (!result?.valid) {
        return yield* Effect.fail(new UnauthorizedError({ message: 'Invalid API key' }))
      }

      const metadata = (result as { metadata?: { orgId?: string } }).metadata
      return yield* Effect.provideService(app, AuthContext, {
        userId: (result as { userId?: string }).userId ?? '',
        orgId: metadata?.orgId ?? '',
      })
    }

    const sessionResult = yield* Effect.tryPromise({
      try: () =>
        auth.api.getSession({
          headers: new Headers(request.headers as Record<string, string>),
        }),
      catch: () => new UnauthorizedError({ message: 'Invalid session' }),
    })

    if (!sessionResult?.session) {
      return yield* Effect.fail(new UnauthorizedError({ message: 'Authentication required' }))
    }

    return yield* Effect.provideService(app, AuthContext, {
      userId: sessionResult.session.userId,
      orgId:
        (sessionResult.session as { activeOrganizationId?: string }).activeOrganizationId ?? '',
    })
  }),
)
