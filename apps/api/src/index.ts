import { NodeHttpServer, NodeRuntime } from '@effect/platform-node'
import { Layer } from 'effect'
import { createServer } from 'node:http'
import { AppLive } from './server.js'

const PORT = Number(process.env.PORT ?? 3000)

const ServerLive = AppLive.pipe(
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: PORT })),
)

NodeRuntime.runMain(Layer.launch(ServerLive))
