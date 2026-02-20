import { HttpRouter } from '@effect/platform'
import { Effect } from 'effect'
import { NotImplementedError } from '../errors.js'

const stub = (name: string) => Effect.fail(new NotImplementedError({ message: `${name} not yet implemented` }))

export const FileRouter = HttpRouter.empty.pipe(
  HttpRouter.put('/v1/sandboxes/:id/files', stub('Upload file')),
  HttpRouter.get('/v1/sandboxes/:id/files', stub('Download or list files')),
  HttpRouter.del('/v1/sandboxes/:id/files', stub('Delete file')),
)
