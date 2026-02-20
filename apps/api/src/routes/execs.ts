import { HttpRouter } from '@effect/platform'
import { Effect } from 'effect'
import { NotImplementedError } from '../errors.js'

const stub = (name: string) => Effect.fail(new NotImplementedError({ message: `${name} not yet implemented` }))

export const ExecRouter = HttpRouter.empty.pipe(
  HttpRouter.post('/v1/sandboxes/:id/exec', stub('Execute command')),
  HttpRouter.get('/v1/sandboxes/:id/exec/:execId', stub('Get exec')),
  HttpRouter.get('/v1/sandboxes/:id/execs', stub('List execs')),
  HttpRouter.get('/v1/sandboxes/:id/exec/:execId/stream', stub('Stream exec output')),
)
