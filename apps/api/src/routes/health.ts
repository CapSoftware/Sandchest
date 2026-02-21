import { HttpRouter, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { RedisService } from '../services/redis.js'
import { ShutdownController } from '../shutdown.js'

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
      const shutdown = yield* ShutdownController
      const redisOk = yield* redis.ping()
      const draining = yield* shutdown.isDraining

      const checks = {
        redis: redisOk ? ('ok' as const) : ('fail' as const),
        shutdown: draining ? ('draining' as const) : ('ok' as const),
      }
      const allOk = redisOk && !draining

      return HttpServerResponse.unsafeJson(
        { status: allOk ? 'ok' : 'degraded', checks },
        { status: allOk ? 200 : 503 },
      )
    }),
  ),
)
