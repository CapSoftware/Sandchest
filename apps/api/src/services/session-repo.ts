import { Context, type Effect } from 'effect'
import type { SessionStatus } from '@sandchest/contract'

/** Internal session row representation. */
export interface SessionRow {
  readonly id: Uint8Array
  readonly sandboxId: Uint8Array
  readonly orgId: string
  readonly shell: string
  readonly status: SessionStatus
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly destroyedAt: Date | null
}

export interface SessionRepoApi {
  /** Insert a new session row and return it. */
  readonly create: (params: {
    id: Uint8Array
    sandboxId: Uint8Array
    orgId: string
    shell: string
  }) => Effect.Effect<SessionRow, never, never>

  /** Find a session by id, scoped to sandbox and org. */
  readonly findById: (
    id: Uint8Array,
    sandboxId: Uint8Array,
    orgId: string,
  ) => Effect.Effect<SessionRow | null, never, never>

  /** List active sessions for a sandbox. */
  readonly list: (
    sandboxId: Uint8Array,
    orgId: string,
  ) => Effect.Effect<SessionRow[], never, never>

  /** Count active (running) sessions for a sandbox. */
  readonly countActive: (
    sandboxId: Uint8Array,
  ) => Effect.Effect<number, never, never>

  /** Mark a session as destroyed. */
  readonly destroy: (
    id: Uint8Array,
    sandboxId: Uint8Array,
    orgId: string,
  ) => Effect.Effect<SessionRow | null, never, never>
}

export class SessionRepo extends Context.Tag('SessionRepo')<SessionRepo, SessionRepoApi>() {}
