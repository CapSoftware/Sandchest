import { HttpRouter, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { spec } from '../openapi.js'

const SCALAR_VERSION = '1.27.21'

const scalarHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sandchest API Reference</title>
</head>
<body>
  <script id="api-reference" data-url="/openapi.json"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.min.js" crossorigin></script>
</body>
</html>`

export const DocsRouter = HttpRouter.empty.pipe(
  HttpRouter.get(
    '/openapi.json',
    Effect.succeed(
      HttpServerResponse.unsafeJson(spec, {
        headers: { 'cache-control': 'public, max-age=3600' },
      }),
    ),
  ),

  HttpRouter.get(
    '/docs',
    Effect.succeed(
      HttpServerResponse.raw(scalarHtml, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        },
      }),
    ),
  ),
)
