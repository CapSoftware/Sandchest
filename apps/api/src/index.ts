import { HttpServer } from '@effect/platform'
import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import { Layer } from 'effect'
import { createServer } from 'node:http'
import { ApiRouter } from './server.js'
import { withAuth, withRequestId } from './middleware.js'
import { SandboxRepoMemory } from './services/sandbox-repo.memory.js'

const PORT = Number(process.env.PORT ?? 3000)

// Production pipeline: withAuth provides AuthContext per-request
const AppLive = ApiRouter.pipe(withAuth, withRequestId, HttpServer.serve())

const ServerLive = AppLive.pipe(
  Layer.provide(SandboxRepoMemory),
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: PORT })),
)

NodeRuntime.runMain(Layer.launch(ServerLive))
