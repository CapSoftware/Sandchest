import { Context } from 'effect'
import type { ApiKeyScope } from '@sandchest/contract'

export interface AuthInfo {
  readonly userId: string
  readonly orgId: string
  /** Scopes granted to this auth context. `null` means full access (session auth or legacy keys). */
  readonly scopes: readonly ApiKeyScope[] | null
}

export class AuthContext extends Context.Tag('AuthContext')<AuthContext, AuthInfo>() {}
