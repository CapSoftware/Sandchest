import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect, Either } from 'effect'
import { timingSafeEqual } from 'node:crypto'
import { parseScopes } from '@sandchest/contract'
import { RateLimitedError, UnauthorizedError, formatApiError } from './errors.js'
import { AuthContext } from './context.js'
import { auth } from './auth.js'
import { loadEnv } from './env.js'

type BetterAuthErrorShape = {
  statusCode?: number
  headers?: Record<string, string>
  body?: {
    code?: string
    message?: string
    details?: Record<string, unknown>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function collectErrorCandidates(error: unknown): BetterAuthErrorShape[] {
  const queue: unknown[] = [error]
  const seen = new Set<unknown>()
  const candidates: BetterAuthErrorShape[] = []

  while (queue.length > 0) {
    const current = queue.shift()
    if (!isRecord(current) || seen.has(current)) {
      continue
    }
    seen.add(current)
    candidates.push(current as BetterAuthErrorShape)

    for (const key of ['cause', 'body', 'response', 'error']) {
      const next = current[key]
      if (next !== undefined) {
        queue.push(next)
      }
    }
  }

  return candidates
}

function extractRetryAfterSeconds(error: BetterAuthErrorShape): number {
  const headerValue = error.headers?.['retry-after'] ?? error.headers?.['Retry-After']
  const headerSeconds = headerValue ? Number(headerValue) : NaN
  if (Number.isFinite(headerSeconds) && headerSeconds > 0) {
    return headerSeconds
  }

  const details = error.body?.details
  const candidates = [
    details?.['retryAfter'],
    details?.['retry_after'],
  ]

  for (const value of candidates) {
    const seconds = typeof value === 'number' ? value : Number(value)
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds
    }
  }

  return 60
}

export function normalizeApiKeyVerificationError(error: unknown) {
  const messageText = error instanceof Error ? error.message : String(error ?? '')
  const candidates = collectErrorCandidates(error)

  for (const candidate of candidates) {
    const code = candidate.body?.code
    const message = candidate.body?.message
    const status = candidate.statusCode

    if (
      code === 'RATE_LIMITED' ||
      (typeof message === 'string' && /rate limit exceeded/i.test(message)) ||
      (status === 429 && typeof message === 'string')
    ) {
      return new RateLimitedError({
        message: message ?? 'Rate limit exceeded.',
        retryAfter: extractRetryAfterSeconds(candidate),
      })
    }
  }

  if (/rate limit exceeded/i.test(messageText)) {
    return new RateLimitedError({
      message: 'Rate limit exceeded.',
      retryAfter: 60,
    })
  }

  return new UnauthorizedError({ message: 'Invalid API key' })
}

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
      const verification = yield* Effect.either(Effect.tryPromise({
        try: () => auth.api.verifyApiKey({ body: { key } }),
        catch: normalizeApiKeyVerificationError,
      }))

      if (Either.isLeft(verification)) {
        return formatApiError(verification.left)
      }

      const result = verification.right

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
