import { Context } from 'effect'

export interface AuthInfo {
  readonly userId: string
  readonly orgId: string
}

export class AuthContext extends Context.Tag('AuthContext')<AuthContext, AuthInfo>() {}
