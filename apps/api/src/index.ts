import { HttpServer } from '@effect/platform'
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import { Duration, Effect, Layer } from 'effect'
import { createServer } from 'node:http'
import { loadEnv } from './env.js'
import { ApiRouter } from './server.js'
import { withAuth, withRequestId } from './middleware.js'
import { withConnectionDrain } from './middleware/connection-drain.js'
import { withRateLimit } from './middleware/rate-limit.js'
import { withSecurityHeaders } from './middleware/security-headers.js'
import { SandboxRepoMemory } from './services/sandbox-repo.memory.js'
import { ExecRepoMemory } from './services/exec-repo.memory.js'
import { SessionRepoMemory } from './services/session-repo.memory.js'
import { ObjectStorageMemory } from './services/object-storage.memory.js'
import { createObjectStorageLayer } from './services/object-storage.live.js'
import { NodeClientMemory } from './services/node-client.memory.js'
import { createNodeClientLayer } from './services/node-client.live.js'
import { ArtifactRepoMemory } from './services/artifact-repo.memory.js'
import { createRedisLayer } from './services/redis.ioredis.js'
import { RedisMemory } from './services/redis.memory.js'
import { EventRecorderLive } from './services/event-recorder.live.js'
import { IdempotencyRepoMemory } from './workers/idempotency-cleanup.memory.js'
import { OrgRepoMemory } from './services/org-repo.memory.js'
import { AuditLogMemory } from './services/audit-log.memory.js'
import { NodeRepoMemory } from './services/node-repo.memory.js'
import { MetricsRepoMemory } from './services/metrics-repo.memory.js'
import { QuotaMemory } from './services/quota.memory.js'
import { UsageMemory } from './services/usage.memory.js'
import { BillingLive } from './services/billing.live.js'
import { startAllWorkers } from './workers/index.js'
import { JsonLoggerLive } from './logger.js'
import { ShutdownController, ShutdownControllerLive } from './shutdown.js'

const env = loadEnv()
const { PORT, REDIS_URL, REDIS_FAMILY, DRAIN_TIMEOUT_MS, SANDCHEST_S3_ENDPOINT, SANDCHEST_S3_ACCESS_KEY, SANDCHEST_S3_SECRET_KEY, SANDCHEST_S3_REGION, ARTIFACT_BUCKET_NAME } = env

// Production pipeline: connection drain is outermost so it gates all requests
const AppLive = ApiRouter.pipe(
  withConnectionDrain,
  withRateLimit,
  withAuth,
  withRequestId,
  withSecurityHeaders,
  HttpServer.serve(),
)

const RedisLive = REDIS_URL ? createRedisLayer(REDIS_URL, { family: REDIS_FAMILY }) : RedisMemory

const { NODE_GRPC_ADDR, NODE_GRPC_CERT_PATH, NODE_GRPC_KEY_PATH, NODE_GRPC_CA_PATH, NODE_GRPC_NODE_ID } = env
const NodeClientLive =
  NODE_GRPC_ADDR && NODE_GRPC_CERT_PATH && NODE_GRPC_KEY_PATH && NODE_GRPC_CA_PATH && NODE_GRPC_NODE_ID
    ? createNodeClientLayer({
        address: NODE_GRPC_ADDR,
        certPath: NODE_GRPC_CERT_PATH,
        keyPath: NODE_GRPC_KEY_PATH,
        caPath: NODE_GRPC_CA_PATH,
        nodeId: NODE_GRPC_NODE_ID,
      })
    : NodeClientMemory

const ObjectStorageLive =
  SANDCHEST_S3_ENDPOINT && SANDCHEST_S3_ACCESS_KEY && SANDCHEST_S3_SECRET_KEY && ARTIFACT_BUCKET_NAME
    ? createObjectStorageLayer({
        endpoint: SANDCHEST_S3_ENDPOINT,
        accessKeyId: SANDCHEST_S3_ACCESS_KEY,
        secretAccessKey: SANDCHEST_S3_SECRET_KEY,
        region: SANDCHEST_S3_REGION,
        bucket: ARTIFACT_BUCKET_NAME,
      })
    : ObjectStorageMemory

// Workers launch as scoped fibers alongside the HTTP server
const WorkersLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    yield* startAllWorkers()
  }),
)

// Graceful shutdown: listen for SIGTERM/SIGINT, drain connections, then exit.
// Signal handlers run outside the Effect runtime to avoid racing with
// NodeRuntime.runMain's own SIGTERM handler (which interrupts the fiber).
const GracefulShutdownLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const shutdown = yield* ShutdownController

    const handleShutdown = () => {
      Effect.runFork(
        shutdown.beginDrain.pipe(
          Effect.andThen(
            Effect.race(
              shutdown.awaitDrained,
              Effect.sleep(Duration.millis(DRAIN_TIMEOUT_MS)),
            ),
          ),
          Effect.ensuring(Effect.sync(() => process.exit(0))),
        ),
      )
    }

    process.on('SIGTERM', handleShutdown)
    process.on('SIGINT', handleShutdown)

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.removeListener('SIGTERM', handleShutdown)
        process.removeListener('SIGINT', handleShutdown)
      }),
    )

    yield* Effect.log(`Server started on port ${PORT}`)
  }),
)

const ServerLive = Layer.mergeAll(AppLive, WorkersLive, GracefulShutdownLive).pipe(
  Layer.provide(ShutdownControllerLive),
  Layer.provide(EventRecorderLive),
  Layer.provide(SandboxRepoMemory),
  Layer.provide(ExecRepoMemory),
  Layer.provide(SessionRepoMemory),
  Layer.provide(ObjectStorageLive),
  Layer.provide(NodeClientLive),
  Layer.provide(ArtifactRepoMemory),
  Layer.provide(IdempotencyRepoMemory),
  Layer.provide(OrgRepoMemory),
  Layer.provide(QuotaMemory),
  Layer.provide(UsageMemory),
  Layer.provide(AuditLogMemory),
  Layer.provide(NodeRepoMemory),
  Layer.provide(MetricsRepoMemory),
  Layer.provide(BillingLive),
  Layer.provide(RedisLive),
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: PORT })),
  Layer.provide(JsonLoggerLive),
)

NodeRuntime.runMain(Layer.launch(ServerLive))
