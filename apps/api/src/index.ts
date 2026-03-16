import { HttpMiddleware, HttpServer } from '@effect/platform'
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import { Duration, Effect, Layer } from 'effect'
import { createServer } from 'node:http'
import { createDatabase } from '@sandchest/db/client'
import { loadEnv } from './env.js'
import { ApiRouter } from './server.js'
import { formatApiError } from './errors.js'
import { withAuth, withRequestId } from './middleware.js'
import { withConnectionDrain } from './middleware/connection-drain.js'
import { withRateLimit } from './middleware/rate-limit.js'
import { withSecurityHeaders } from './middleware/security-headers.js'
import { makeSandboxRepoDrizzle } from './services/sandbox-repo.drizzle.js'
import { makeExecRepoDrizzle } from './services/exec-repo.drizzle.js'
import { makeSessionRepoDrizzle } from './services/session-repo.drizzle.js'
import { ObjectStorageMemory } from './services/object-storage.memory.js'
import { createObjectStorageLayer } from './services/object-storage.live.js'
import { NodeClientRegistryMemory } from './services/node-client-registry.memory.js'
import { createNodeClientRegistryLayer, type RegistryConfig } from './services/node-client-registry.live.js'
import { NodeLookupLive } from './services/node-lookup.live.js'
import { makeArtifactRepoDrizzle } from './services/artifact-repo.drizzle.js'
import { createRedisLayer } from './services/redis.ioredis.js'
import { RedisMemory } from './services/redis.memory.js'
import { EventRecorderLive } from './services/event-recorder.live.js'
import { makeIdempotencyRepoDrizzle } from './workers/idempotency-cleanup.drizzle.js'
import { makeOrgRepoDrizzle } from './services/org-repo.drizzle.js'
import { makeAuditLogDrizzle } from './services/audit-log.drizzle.js'
import { makeNodeRepoDrizzle } from './services/node-repo.drizzle.js'
import { makeMetricsRepoDrizzle } from './services/metrics-repo.drizzle.js'
import { makeQuotaDrizzle } from './services/quota.drizzle.js'
import { makeUsageDrizzle } from './services/usage.drizzle.js'
import { BillingLive } from './services/billing.live.js'
import { startAllWorkers } from './workers/index.js'
import { JsonLoggerLive } from './logger.js'
import { ShutdownController, ShutdownControllerLive } from './shutdown.js'

const env = loadEnv()
const { PORT, DATABASE_URL, REDIS_URL, REDIS_FAMILY, DRAIN_TIMEOUT_MS, SANDCHEST_S3_ENDPOINT, SANDCHEST_S3_ACCESS_KEY, SANDCHEST_S3_SECRET_KEY, SANDCHEST_S3_REGION, ARTIFACT_BUCKET_NAME } = env

const db = createDatabase(DATABASE_URL)

/** Catches Effect defects (unexpected errors) and returns a proper JSON 500 response. */
const withDefectHandler = HttpMiddleware.make((app) =>
  app.pipe(
    Effect.catchAllDefect((defect) =>
      Effect.gen(function* () {
        const message = defect instanceof Error ? defect.message : String(defect)
        yield* Effect.logError(`Unhandled defect: ${message}`)
        return formatApiError(new Error('internal defect'))
      }),
    ),
  ),
)

// Production pipeline: defect handler is outermost so it catches defects from
// any middleware layer (auth, rate-limit, etc.), not just the router.
const AppLive = ApiRouter.pipe(
  withConnectionDrain,
  withRateLimit,
  withAuth,
  withRequestId,
  withSecurityHeaders,
  withDefectHandler,
  HttpServer.serve(),
)

const isProduction = env.NODE_ENV === 'production'

const RedisLive = REDIS_URL ? createRedisLayer(REDIS_URL, { family: REDIS_FAMILY }) : RedisMemory

const { NODE_GRPC_CERT_PATH, NODE_GRPC_KEY_PATH, NODE_GRPC_CA_PATH, NODE_GRPC_INSECURE, MTLS_CA_PEM, MTLS_CLIENT_CERT_PEM, MTLS_CLIENT_KEY_PEM } = env
const hasPemContent = MTLS_CA_PEM && MTLS_CLIENT_CERT_PEM && MTLS_CLIENT_KEY_PEM
const hasFilePaths = NODE_GRPC_CERT_PATH && NODE_GRPC_KEY_PATH && NODE_GRPC_CA_PATH
const hasMtlsConfig = NODE_GRPC_INSECURE || hasPemContent || hasFilePaths

const registryConfig: RegistryConfig = {
  insecure: NODE_GRPC_INSECURE,
  caPem: MTLS_CA_PEM,
  certPem: MTLS_CLIENT_CERT_PEM,
  keyPem: MTLS_CLIENT_KEY_PEM,
  caPath: NODE_GRPC_CA_PATH,
  certPath: NODE_GRPC_CERT_PATH,
  keyPath: NODE_GRPC_KEY_PATH,
}

const NodeClientRegistryLive = hasMtlsConfig
  ? createNodeClientRegistryLayer(registryConfig)
  : NodeClientRegistryMemory

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

// In production, warn when infrastructure services fall back to in-memory stubs.
// These fallbacks work for local dev but silently degrade real deployments.
const ProductionFallbackWarnings = Layer.scopedDiscard(
  Effect.gen(function* () {
    if (!isProduction) return

    if (!REDIS_URL) {
      yield* Effect.logWarning(
        'REDIS_URL is not set — using in-memory stub. Rate limiting, workers, SSE reconnection, and event buffering are degraded. Fix: flyctl secrets set REDIS_URL=<url> REDIS_FAMILY=6',
      )
    }

    if (!(SANDCHEST_S3_ENDPOINT && SANDCHEST_S3_ACCESS_KEY && SANDCHEST_S3_SECRET_KEY && ARTIFACT_BUCKET_NAME)) {
      yield* Effect.logWarning(
        'Object storage is not configured — using in-memory stub. Artifacts and event logs will not persist. Fix: set SANDCHEST_S3_ENDPOINT, SANDCHEST_S3_ACCESS_KEY, SANDCHEST_S3_SECRET_KEY, and ARTIFACT_BUCKET_NAME',
      )
    }

    if (!hasMtlsConfig) {
      yield* Effect.logWarning(
        'Node gRPC mTLS is not configured — using in-memory stub. Sandbox creation, exec, and session operations will return mock data. Fix: set NODE_GRPC_INSECURE=1 for localhost or set mTLS credentials (MTLS_CA_PEM, MTLS_CLIENT_CERT_PEM, MTLS_CLIENT_KEY_PEM or file path equivalents)',
      )
    }

    if (process.env.NODE_GRPC_ADDR || process.env.NODE_GRPC_NODE_ID) {
      yield* Effect.logWarning(
        'NODE_GRPC_ADDR and NODE_GRPC_NODE_ID are deprecated and ignored. The API now discovers nodes from the database. Remove these env vars to silence this warning.',
      )
    }
  }),
)

const ServerLive = Layer.mergeAll(AppLive, WorkersLive, GracefulShutdownLive, ProductionFallbackWarnings).pipe(
  Layer.provide(ShutdownControllerLive),
  Layer.provide(EventRecorderLive),
  Layer.provide(makeSandboxRepoDrizzle(db)),
  Layer.provide(makeExecRepoDrizzle(db)),
  Layer.provide(makeSessionRepoDrizzle(db)),
  Layer.provide(ObjectStorageLive),
  Layer.provide(NodeClientRegistryLive),
  Layer.provide(NodeLookupLive),
  Layer.provide(makeArtifactRepoDrizzle(db)),
  Layer.provide(makeIdempotencyRepoDrizzle(db)),
  Layer.provide(makeOrgRepoDrizzle(db)),
  Layer.provide(makeQuotaDrizzle(db)),
  Layer.provide(makeUsageDrizzle(db)),
  Layer.provide(makeAuditLogDrizzle(db)),
  Layer.provide(makeNodeRepoDrizzle(db)),
  Layer.provide(makeMetricsRepoDrizzle(db)),
  Layer.provide(BillingLive),
  Layer.provide(RedisLive),
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: PORT })),
  Layer.provide(JsonLoggerLive),
)

NodeRuntime.runMain(Layer.launch(ServerLive))
