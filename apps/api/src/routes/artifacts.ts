import { HttpRouter } from '@effect/platform'
import { Effect } from 'effect'
import { NotImplementedError } from '../errors.js'

const stub = (name: string) => Effect.fail(new NotImplementedError({ message: `${name} not yet implemented` }))

export const ArtifactRouter = HttpRouter.empty.pipe(
  HttpRouter.post('/v1/sandboxes/:id/artifacts', stub('Register artifacts')),
  HttpRouter.get('/v1/sandboxes/:id/artifacts', stub('List artifacts')),
)
