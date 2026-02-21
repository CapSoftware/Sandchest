import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { RedisService } from '../services/redis.js'

const DEFAULT_HEARTBEAT_TTL = 30

/**
 * Internal node routes. Called by node daemons, not user-facing.
 * Auth is skipped via the /v1/internal/ prefix in middleware.
 */
export const NodeRouter = HttpRouter.empty.pipe(
  HttpRouter.post(
    '/v1/internal/nodes/:nodeId/heartbeat',
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const params = yield* HttpRouter.params
      const nodeId = params.nodeId!

      let ttlSeconds = DEFAULT_HEARTBEAT_TTL
      const raw = yield* request.json.pipe(Effect.orElseSucceed(() => ({})))
      const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
      if (typeof body.ttl_seconds === 'number' && body.ttl_seconds > 0) {
        ttlSeconds = Math.min(body.ttl_seconds, 300)
      }

      const redis = yield* RedisService
      yield* redis.registerNodeHeartbeat(nodeId, ttlSeconds)

      return HttpServerResponse.unsafeJson(
        { node_id: nodeId, ttl_seconds: ttlSeconds },
        { status: 200 },
      )
    }),
  ),
)
