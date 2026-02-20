import { HttpRouter, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'

export const HealthRouter = HttpRouter.empty.pipe(
  HttpRouter.get(
    '/health',
    Effect.succeed(HttpServerResponse.unsafeJson({ status: 'ok' })),
  ),
)
