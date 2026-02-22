import { Effect } from 'effect'
import type { ApiKeyScope } from '@sandchest/contract'
import { AuthContext } from './context.js'
import { ForbiddenError } from './errors.js'

/**
 * Checks that the current auth context has the required scope.
 * - `null` scopes (session auth or legacy keys with no scopes) are treated as full access.
 * - API keys with explicit scopes must include the required scope.
 */
export function requireScope(scope: ApiKeyScope) {
  return Effect.gen(function* () {
    const auth = yield* AuthContext
    if (auth.scopes !== null && !auth.scopes.includes(scope)) {
      return yield* Effect.fail(
        new ForbiddenError({
          message: `API key missing required scope: ${scope}`,
        }),
      )
    }
  })
}
