import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'

const ALLOWED_ORIGINS = ['https://sandchest.com']

const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/[\w-]+\.sandchest\.com$/,
  /^http:\/\/localhost(:\d+)?$/,
]

const CORS_METHODS = 'GET, POST, PUT, DELETE, OPTIONS'
const CORS_HEADERS = 'Authorization, Content-Type, X-Request-Id, Idempotency-Key'
const CORS_EXPOSE =
  'X-Request-Id, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-Replay-Access'
const CORS_MAX_AGE = '86400'
const HSTS_VALUE = 'max-age=63072000; includeSubDomains; preload'

export function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true
  return ALLOWED_ORIGIN_PATTERNS.some((p) => p.test(origin))
}

function addCorsHeaders(
  response: HttpServerResponse.HttpServerResponse,
  origin: string,
): HttpServerResponse.HttpServerResponse {
  return response.pipe(
    HttpServerResponse.setHeader('access-control-allow-origin', origin),
    HttpServerResponse.setHeader('access-control-allow-methods', CORS_METHODS),
    HttpServerResponse.setHeader('access-control-allow-headers', CORS_HEADERS),
    HttpServerResponse.setHeader('access-control-expose-headers', CORS_EXPOSE),
    HttpServerResponse.setHeader('access-control-max-age', CORS_MAX_AGE),
    HttpServerResponse.setHeader('access-control-allow-credentials', 'true'),
    HttpServerResponse.setHeader('vary', 'Origin'),
  )
}

/**
 * Security headers middleware: CORS + HSTS.
 * Handles OPTIONS preflight and adds appropriate headers to all responses.
 */
export const withSecurityHeaders = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const origin = request.headers['origin'] ?? ''

    // OPTIONS preflight — short-circuit before auth/rate-limit
    if (request.method === 'OPTIONS' && origin) {
      const base = HttpServerResponse.empty({ status: 204 }).pipe(
        HttpServerResponse.setHeader('strict-transport-security', HSTS_VALUE),
      )
      return isAllowedOrigin(origin) ? addCorsHeaders(base, origin) : base
    }

    const response = yield* app

    // HSTS on all responses
    let result = response.pipe(
      HttpServerResponse.setHeader('strict-transport-security', HSTS_VALUE),
    )

    // CORS headers when origin is allowed
    if (origin && isAllowedOrigin(origin)) {
      result = addCorsHeaders(result, origin)
    }

    return result
  }),
)
