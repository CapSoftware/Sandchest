import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { AuthContext } from '../context.js'
import { RateLimitedError, formatApiError } from '../errors.js'
import { RedisService, type RateLimitResult } from '../services/redis.js'
import { QuotaService, type OrgQuota } from '../services/quota.js'

/** Rate limit categories mapped to request paths. */
type RateLimitCategory = 'sandbox_create' | 'exec' | 'read'

const WINDOW_SECONDS = 60

function categorize(method: string, url: string): RateLimitCategory | null {
  if (method === 'POST' && url.endsWith('/sandboxes')) return 'sandbox_create'
  if (method === 'POST' && url.includes('/exec')) return 'exec'
  if (method === 'GET') return 'read'
  return null
}

function limitForCategory(quota: OrgQuota, category: RateLimitCategory): number {
  switch (category) {
    case 'sandbox_create':
      return quota.rateSandboxCreatePerMin
    case 'exec':
      return quota.rateExecPerMin
    case 'read':
      return quota.rateReadPerMin
  }
}

/**
 * Redis-backed rate limiting middleware.
 * Reads per-org limits from QuotaService.
 * Skips auth/health routes. Adds X-RateLimit-* headers.
 */
export const withRateLimit = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = request.url

    // Skip non-API paths
    if (url.startsWith('/health') || url.startsWith('/api/auth') || url.startsWith('/v1/public/')) {
      return yield* app
    }

    const category = categorize(request.method, url)
    if (!category) {
      return yield* app
    }

    const auth = yield* AuthContext
    if (!auth.orgId) {
      return yield* app
    }

    const redis = yield* RedisService
    const quotaService = yield* QuotaService
    const quota = yield* quotaService.getOrgQuota(auth.orgId)
    const limit = limitForCategory(quota, category)

    const result = yield* redis
      .checkRateLimit(auth.orgId, category, limit, WINDOW_SECONDS)
      .pipe(
        Effect.catchAllDefect(() =>
          Effect.logWarning('Redis unavailable for rate limiting, failing open').pipe(
            Effect.map(
              (): RateLimitResult => ({
                allowed: true,
                remaining: limit,
                resetAt: Date.now() + WINDOW_SECONDS * 1000,
              }),
            ),
          ),
        ),
      )

    if (!result.allowed) {
      const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000)
      return formatApiError(
        new RateLimitedError({
          message: 'Rate limit exceeded',
          retryAfter: Math.max(1, retryAfter),
        }),
      )
    }

    const response = yield* app
    return response.pipe(
      HttpServerResponse.setHeader('x-ratelimit-limit', String(limit)),
      HttpServerResponse.setHeader('x-ratelimit-remaining', String(result.remaining)),
      HttpServerResponse.setHeader('x-ratelimit-reset', String(Math.ceil(result.resetAt / 1000))),
    )
  }),
)
