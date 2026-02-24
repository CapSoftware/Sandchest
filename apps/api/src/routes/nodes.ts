import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { idToBytes } from '@sandchest/contract'
import { RedisService } from '../services/redis.js'
import { MetricsRepo } from '../services/metrics-repo.js'

const DEFAULT_HEARTBEAT_TTL = 30

interface MetricsPayload {
  cpu_percent?: number
  memory_used_bytes?: number
  memory_total_bytes?: number
  disk_used_bytes?: number
  disk_total_bytes?: number
  network_rx_bytes?: number
  network_tx_bytes?: number
  load_avg_1?: number
  load_avg_5?: number
  load_avg_15?: number
}

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

      // Store metrics if present
      const metrics = body.metrics as MetricsPayload | undefined
      if (metrics && typeof metrics === 'object' && typeof metrics.cpu_percent === 'number') {
        const metricsRepo = yield* MetricsRepo
        let nodeIdBytes: Uint8Array
        try {
          nodeIdBytes = idToBytes(nodeId)
        } catch {
          // If node ID doesn't parse, skip metrics storage
          return HttpServerResponse.unsafeJson(
            { node_id: nodeId, ttl_seconds: ttlSeconds },
            { status: 200 },
          )
        }

        yield* metricsRepo.insert({
          nodeId: nodeIdBytes,
          cpuPercent: metrics.cpu_percent,
          memoryUsedBytes: BigInt(metrics.memory_used_bytes ?? 0),
          memoryTotalBytes: BigInt(metrics.memory_total_bytes ?? 0),
          diskUsedBytes: BigInt(metrics.disk_used_bytes ?? 0),
          diskTotalBytes: BigInt(metrics.disk_total_bytes ?? 0),
          networkRxBytes: BigInt(metrics.network_rx_bytes ?? 0),
          networkTxBytes: BigInt(metrics.network_tx_bytes ?? 0),
          loadAvg1: metrics.load_avg_1 ?? 0,
          loadAvg5: metrics.load_avg_5 ?? 0,
          loadAvg15: metrics.load_avg_15 ?? 0,
        })
      }

      return HttpServerResponse.unsafeJson(
        { node_id: nodeId, ttl_seconds: ttlSeconds },
        { status: 200 },
      )
    }),
  ),
)
