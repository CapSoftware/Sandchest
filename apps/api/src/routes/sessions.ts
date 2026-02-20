import { HttpRouter } from '@effect/platform'
import { Effect } from 'effect'
import { NotImplementedError } from '../errors.js'

const stub = (name: string) => Effect.fail(new NotImplementedError({ message: `${name} not yet implemented` }))

export const SessionRouter = HttpRouter.empty.pipe(
  HttpRouter.post('/v1/sandboxes/:id/sessions', stub('Create session')),
  HttpRouter.post('/v1/sandboxes/:id/sessions/:sessionId/exec', stub('Session exec')),
  HttpRouter.post('/v1/sandboxes/:id/sessions/:sessionId/input', stub('Session input')),
  HttpRouter.get('/v1/sandboxes/:id/sessions/:sessionId/stream', stub('Session stream')),
  HttpRouter.get('/v1/sandboxes/:id/sessions', stub('List sessions')),
  HttpRouter.del('/v1/sandboxes/:id/sessions/:sessionId', stub('Destroy session')),
)
