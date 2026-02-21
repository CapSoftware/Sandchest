import { HttpMiddleware, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { ShutdownController } from '../shutdown.js'

/**
 * Middleware that tracks in-flight connections and rejects new requests
 * with 503 + Connection: close when the server is draining.
 *
 * Health/liveness probes are always allowed through so orchestrators
 * can observe the shutdown transition.
 */
export const withConnectionDrain = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const shutdown = yield* ShutdownController
    const request = yield* HttpServerRequest.HttpServerRequest

    // Always let health probes through so load balancers see the transition
    const isProbe =
      request.url === '/health' || request.url === '/healthz' || request.url === '/readyz'

    const draining = yield* shutdown.isDraining

    if (draining && !isProbe) {
      return HttpServerResponse.unsafeJson(
        { error: 'service_unavailable', message: 'Server is shutting down', request_id: null, retry_after: null },
        {
          status: 503,
          headers: { connection: 'close' },
        },
      )
    }

    const release = yield* shutdown.trackConnection
    const response = yield* app
    yield* release

    return draining
      ? response.pipe(HttpServerResponse.setHeader('connection', 'close'))
      : response
  }),
)
