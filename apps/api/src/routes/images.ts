import { HttpRouter, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { SandboxRepo } from '../services/sandbox-repo.js'

// -- List images ---------------------------------------------------------------

const listImages = Effect.gen(function* () {
  const repo = yield* SandboxRepo

  const rows = yield* repo.listImages()

  const images = rows.map((row) => ({
    id: `${row.osVersion}/${row.toolchain}`,
    os_version: row.osVersion,
    toolchain: row.toolchain,
    description: describeImage(row.osVersion, row.toolchain),
  }))

  return HttpServerResponse.unsafeJson({ images })
})

function describeImage(osVersion: string, toolchain: string): string {
  const os = osVersion === 'ubuntu-22.04' ? 'Ubuntu 22.04' : osVersion
  switch (toolchain) {
    case 'base':
      return `${os} (minimal)`
    case 'node-22':
      return `${os} + Node.js 22`
    case 'bun':
      return `${os} + Bun`
    case 'python-3.12':
      return `${os} + Python 3.12`
    case 'go-1.22':
      return `${os} + Go 1.22`
    default:
      return `${os} + ${toolchain}`
  }
}

// -- Router -------------------------------------------------------------------

export const ImageRouter = HttpRouter.empty.pipe(
  HttpRouter.get('/v1/images', listImages),
)
