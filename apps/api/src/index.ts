import { HttpServer } from '@effect/platform'
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import { Layer } from 'effect'
import { createServer } from 'node:http'
import { ApiRouter } from './server.js'
import { withAuth, withRequestId } from './middleware.js'
import { withRateLimit } from './middleware/rate-limit.js'
import { SandboxRepoMemory } from './services/sandbox-repo.memory.js'
import { ExecRepoMemory } from './services/exec-repo.memory.js'
import { SessionRepoMemory } from './services/session-repo.memory.js'
import { ObjectStorageMemory } from './services/object-storage.memory.js'
import { NodeClientMemory } from './services/node-client.memory.js'
import { createRedisLayer } from './services/redis.ioredis.js'
import { RedisMemory } from './services/redis.memory.js'

const PORT = Number(process.env.PORT ?? 3000)
const REDIS_URL = process.env.REDIS_URL

// Production pipeline: withAuth provides AuthContext, withRateLimit uses Redis
const AppLive = ApiRouter.pipe(withRateLimit, withAuth, withRequestId, HttpServer.serve())

const RedisLive = REDIS_URL ? createRedisLayer(REDIS_URL) : RedisMemory

const ServerLive = AppLive.pipe(
  Layer.provide(SandboxRepoMemory),
  Layer.provide(ExecRepoMemory),
  Layer.provide(SessionRepoMemory),
  Layer.provide(ObjectStorageMemory),
  Layer.provide(NodeClientMemory),
  Layer.provide(RedisLive),
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: PORT })),
)

NodeRuntime.runMain(Layer.launch(ServerLive))
