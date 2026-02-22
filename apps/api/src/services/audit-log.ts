import { Context } from 'effect'
import type { Effect } from 'effect'

export type AuditAction =
  | 'sandbox.create'
  | 'sandbox.delete'
  | 'sandbox.stop'
  | 'sandbox.fork'
  | 'sandbox.replay_visibility'
  | 'api_key.create'
  | 'api_key.revoke'
  | 'org.create'
  | 'org.delete'

export type AuditResourceType =
  | 'sandbox'
  | 'api_key'
  | 'org'

export interface AuditLogEntry {
  readonly id: Uint8Array
  readonly orgId: string
  readonly actorId: string
  readonly action: AuditAction
  readonly resourceType: AuditResourceType
  readonly resourceId: string
  readonly metadata: Record<string, unknown> | null
  readonly createdAt: Date
}

export interface AuditLogApi {
  /** Append an audit log entry. Fire-and-forget safe — errors are swallowed. */
  readonly append: (params: {
    orgId: string
    actorId: string
    action: AuditAction
    resourceType: AuditResourceType
    resourceId: string
    metadata?: Record<string, unknown> | undefined
  }) => Effect.Effect<void, never, never>

  /** List audit log entries for an org, newest first. */
  readonly list: (
    orgId: string,
    params?: { limit?: number | undefined; action?: AuditAction | undefined } | undefined,
  ) => Effect.Effect<AuditLogEntry[], never, never>
}

export class AuditLog extends Context.Tag('AuditLog')<AuditLog, AuditLogApi>() {}
