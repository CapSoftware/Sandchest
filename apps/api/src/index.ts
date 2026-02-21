import { HttpServer } from '@effect/platform'
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { createServer } from 'node:http'
import { ApiRouter } from './server.js'
import { withAuth, withRequestId } from './middleware.js'
import { withRateLimit } from './middleware/rate-limit.js'
import { withSecurityHeaders } from './middleware/security-headers.js'
import { SandboxRepoMemory } from './services/sandbox-repo.memory.js'
import { ExecRepoMemory } from './services/exec-repo.memory.js'
import { SessionRepoMemory } from './services/session-repo.memory.js'
import { ObjectStorageMemory } from './services/object-storage.memory.js'
import { NodeClientMemory } from './services/node-client.memory.js'
import { ArtifactRepoMemory } from './services/artifact-repo.memory.js'
import { createRedisLayer } from './services/redis.ioredis.js'
import { RedisMemory } from './services/redis.memory.js'
import { IdempotencyRepoMemory } from './workers/idempotency-cleanup.memory.js'
import { startAllWorkers } from './workers/index.js'
import { JsonLoggerLive } from './logger.js'

const PORT = Number(process.env.PORT ?? 3000)
const REDIS_URL = process.env.REDIS_URL

// Production pipeline: withAuth provides AuthContext, withRateLimit uses Redis
const AppLive = ApiRouter.pipe(withRateLimit, withAuth, withRequestId, withSecurityHeaders, HttpServer.serve())

const RedisLive = REDIS_URL ? createRedisLayer(REDIS_URL) : RedisMemory

// Workers launch as scoped fibers alongside the HTTP server
const WorkersLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    yield* startAllWorkers()
  }),
)

const ServerLive = Layer.mergeAll(AppLive, WorkersLive).pipe(
  Layer.provide(SandboxRepoMemory),
  Layer.provide(ExecRepoMemory),
  Layer.provide(SessionRepoMemory),
  Layer.provide(ObjectStorageMemory),
  Layer.provide(NodeClientMemory),
  Layer.provide(ArtifactRepoMemory),
  Layer.provide(IdempotencyRepoMemory),
  Layer.provide(RedisLive),
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: PORT })),
  Layer.provide(JsonLoggerLive),
)

NodeRuntime.runMain(Layer.launch(ServerLive))
