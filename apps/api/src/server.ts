import { HttpApp, HttpRouter, HttpServer } from '@effect/platform'
import { Effect } from 'effect'
import { auth } from './auth.js'
import { formatApiError } from './errors.js'
import { withRequestId } from './middleware.js'
import { withRateLimit } from './middleware/rate-limit.js'
import { withSecurityHeaders } from './middleware/security-headers.js'
import { HealthRouter } from './routes/health.js'
import { SandboxRouter } from './routes/sandboxes.js'
import { ExecRouter } from './routes/execs.js'
import { SessionRouter } from './routes/sessions.js'
import { FileRouter } from './routes/files.js'
import { ArtifactRouter } from './routes/artifacts.js'

const betterAuthApp = HttpApp.fromWebHandler((request: Request) => auth.handler(request))

export const ApiRouter = HttpRouter.empty.pipe(
  HttpRouter.concat(HealthRouter),
  HttpRouter.concat(SandboxRouter),
  HttpRouter.concat(ExecRouter),
  HttpRouter.concat(SessionRouter),
  HttpRouter.concat(FileRouter),
  HttpRouter.concat(ArtifactRouter),
  HttpRouter.mountApp('/api/auth', betterAuthApp, { includePrefix: true }),
  HttpRouter.catchAll((error) => Effect.succeed(formatApiError(error))),
)

export const AppLive = ApiRouter.pipe(withRateLimit, withRequestId, withSecurityHeaders, HttpServer.serve())
