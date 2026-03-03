import { HttpMiddleware, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { auth } from './auth.js'
import { formatApiError } from './errors.js'
import { withRequestId } from './middleware.js'
import { withConnectionDrain } from './middleware/connection-drain.js'
import { withRateLimit } from './middleware/rate-limit.js'
import { withSecurityHeaders } from './middleware/security-headers.js'
import { HealthRouter } from './routes/health.js'
import { SandboxRouter } from './routes/sandboxes.js'
import { ExecRouter } from './routes/execs.js'
import { SessionRouter } from './routes/sessions.js'
import { FileRouter } from './routes/files.js'
import { ArtifactRouter } from './routes/artifacts.js'
import { NodeRouter } from './routes/nodes.js'
import { AdminNodeRouter } from './routes/admin-nodes.js'
import { AdminSandboxRouter } from './routes/admin-sandboxes.js'
import { AdminStatusRouter } from './routes/admin-status.js'
import { DocsRouter } from './routes/docs.js'

const handleBetterAuth = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const webReq = yield* HttpServerRequest.toWeb(req)
  const webRes = yield* Effect.tryPromise(() => auth.handler(webReq))
  return yield* Effect.succeed(HttpServerResponse.fromWeb(webRes))
})

export const ApiRouter = HttpRouter.empty.pipe(
  HttpRouter.concat(HealthRouter),
  HttpRouter.concat(SandboxRouter),
  HttpRouter.concat(ExecRouter),
  HttpRouter.concat(SessionRouter),
  HttpRouter.concat(FileRouter),
  HttpRouter.concat(ArtifactRouter),
  HttpRouter.concat(NodeRouter),
  HttpRouter.concat(AdminNodeRouter),
  HttpRouter.concat(AdminSandboxRouter),
  HttpRouter.concat(AdminStatusRouter),
  HttpRouter.concat(DocsRouter),
  HttpRouter.all('/api/auth/*', handleBetterAuth),
  HttpRouter.all('/api/auth', handleBetterAuth),
  HttpRouter.catchAll((error) => Effect.succeed(formatApiError(error))),
)

/** Catches Effect defects (unexpected errors) and returns a proper JSON 500 response. */
const withDefectHandler = HttpMiddleware.make((app) =>
  app.pipe(
    Effect.catchAllDefect(() =>
      Effect.succeed(formatApiError(new Error('internal defect'))),
    ),
  ),
)

export const AppLive = ApiRouter.pipe(withDefectHandler, withConnectionDrain, withRateLimit, withRequestId, withSecurityHeaders, HttpServer.serve())
