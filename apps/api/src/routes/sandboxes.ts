import { HttpRouter } from '@effect/platform'
import { Effect } from 'effect'
import { NotImplementedError } from '../errors.js'

const stub = (name: string) => Effect.fail(new NotImplementedError({ message: `${name} not yet implemented` }))

export const SandboxRouter = HttpRouter.empty.pipe(
  HttpRouter.post('/v1/sandboxes', stub('Create sandbox')),
  HttpRouter.get('/v1/sandboxes', stub('List sandboxes')),
  HttpRouter.get('/v1/sandboxes/:id', stub('Get sandbox')),
  HttpRouter.post('/v1/sandboxes/:id/fork', stub('Fork sandbox')),
  HttpRouter.get('/v1/sandboxes/:id/forks', stub('Get fork tree')),
  HttpRouter.post('/v1/sandboxes/:id/stop', stub('Stop sandbox')),
  HttpRouter.del('/v1/sandboxes/:id', stub('Delete sandbox')),
  HttpRouter.get('/v1/sandboxes/:id/replay', stub('Get replay')),
)
