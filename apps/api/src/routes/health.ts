import { HttpRouter, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { RedisService } from '../services/redis.js'

export const HealthRouter = HttpRouter.empty.pipe(
  HttpRouter.get(
    '/health',
    Effect.succeed(HttpServerResponse.unsafeJson({ status: 'ok' })),
  ),

  HttpRouter.get(
    '/healthz',
    Effect.succeed(HttpServerResponse.unsafeJson({ status: 'ok' })),
  ),

  HttpRouter.get(
    '/readyz',
    Effect.gen(function* () {
      const redis = yield* RedisService
      const redisOk = yield* redis.ping()

      const checks = {
        redis: redisOk ? ('ok' as const) : ('fail' as const),
      }
      const allOk = redisOk

      return HttpServerResponse.unsafeJson(
        { status: allOk ? 'ok' : 'degraded', checks },
        { status: allOk ? 200 : 503 },
      )
    }),
  ),
)
