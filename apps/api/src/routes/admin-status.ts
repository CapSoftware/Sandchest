import { HttpRouter, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { bytesToId, NODE_PREFIX } from '@sandchest/contract'
import { RedisService } from '../services/redis.js'
import { NodeRepo } from '../services/node-repo.js'
import { ShutdownController } from '../shutdown.js'

const WORKER_NAMES = [
  'ttl-enforcement',
  'ttl-warning',
  'idle-shutdown',
  'orphan-reconciliation',
  'queue-timeout',
  'idempotency-cleanup',
  'artifact-retention',
  'org-hard-delete',
  'replay-retention',
  'metrics-retention',
  'vm-teardown',
]

const handler = Effect.gen(function* () {
  const redis = yield* RedisService
  const nodeRepo = yield* NodeRepo
  const shutdown = yield* ShutdownController

  // Redis health
  const redisOk = yield* redis.ping()

  // Worker leader info
  const workers = yield* redis.getWorkerLeaderInfo(WORKER_NAMES)

  // Nodes with heartbeat status
  const nodeRows = yield* nodeRepo.list()
  const nodes = yield* Effect.all(
    nodeRows.map((node) =>
      Effect.gen(function* () {
        const nodeIdStr = bytesToId(NODE_PREFIX, node.id)
        const heartbeatActive = yield* redis.hasNodeHeartbeat(nodeIdStr)
        return {
          id: nodeIdStr,
          status: node.status,
          heartbeat_active: heartbeatActive,
        }
      }),
    ),
  )

  // Drain state
  const draining = yield* shutdown.isDraining

  return HttpServerResponse.unsafeJson({
    api: {
      status: 'ok',
      uptime_seconds: Math.floor(process.uptime()),
      version: '0.0.1',
      draining,
    },
    redis: {
      status: redisOk ? 'ok' : 'fail',
    },
    workers: workers.map((w) => ({
      name: w.name,
      active: w.active,
      ttl_ms: w.ttlMs,
    })),
    nodes,
  })
}).pipe(
  Effect.catchAllDefect((defect) =>
    Effect.gen(function* () {
      const message = defect instanceof Error ? defect.message : String(defect)
      const stack = defect instanceof Error ? defect.stack : undefined
      yield* Effect.logError(`Admin status defect: ${message}`, stack ? { stack } : {})
      return HttpServerResponse.unsafeJson(
        {
          api: { status: 'error', uptime_seconds: Math.floor(process.uptime()), version: '0.0.1', draining: false },
          redis: { status: 'unknown' },
          workers: [],
          nodes: [],
          error: message,
        },
        { status: 500 },
      )
    }),
  ),
)

export const AdminStatusRouter = HttpRouter.empty.pipe(
  HttpRouter.get('/v1/admin/status', handler),
)
