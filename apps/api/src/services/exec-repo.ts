import { Context, type Effect } from 'effect'
import type { ExecStatus } from '@sandchest/contract'

/** Internal exec row representation. */
export interface ExecRow {
  readonly id: Uint8Array
  readonly sandboxId: Uint8Array
  readonly orgId: string
  readonly sessionId: Uint8Array | null
  readonly seq: number
  readonly cmd: string
  readonly cmdFormat: 'array' | 'shell'
  readonly cwd: string | null
  readonly env: Record<string, string> | null
  readonly status: ExecStatus
  readonly exitCode: number | null
  readonly cpuMs: number | null
  readonly peakMemoryBytes: number | null
  readonly durationMs: number | null
  readonly logRef: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly startedAt: Date | null
  readonly endedAt: Date | null
}

export interface ExecRepoApi {
  /** Insert a new exec row and return it. */
  readonly create: (params: {
    id: Uint8Array
    sandboxId: Uint8Array
    orgId: string
    sessionId?: Uint8Array | undefined
    seq: number
    cmd: string
    cmdFormat: 'array' | 'shell'
    cwd?: string | undefined
    env?: Record<string, string> | undefined
  }) => Effect.Effect<ExecRow, never, never>

  /** Find an exec by id, scoped to sandbox and org. */
  readonly findById: (
    id: Uint8Array,
    sandboxId: Uint8Array,
    orgId: string,
  ) => Effect.Effect<ExecRow | null, never, never>

  /** List execs for a sandbox with optional filters and cursor pagination. */
  readonly list: (
    sandboxId: Uint8Array,
    orgId: string,
    params: {
      status?: ExecStatus | undefined
      sessionId?: Uint8Array | undefined
      cursor?: string | undefined
      limit?: number | undefined
    },
  ) => Effect.Effect<{ rows: ExecRow[]; nextCursor: string | null }, never, never>

  /** Update exec status with optional extra fields. Returns updated row or null. */
  readonly updateStatus: (
    id: Uint8Array,
    status: ExecStatus,
    extra?: {
      exitCode?: number | undefined
      cpuMs?: number | undefined
      peakMemoryBytes?: number | undefined
      durationMs?: number | undefined
      startedAt?: Date | undefined
      endedAt?: Date | undefined
    },
  ) => Effect.Effect<ExecRow | null, never, never>

  /** Get the next sequence number for a sandbox. */
  readonly nextSeq: (
    sandboxId: Uint8Array,
  ) => Effect.Effect<number, never, never>

  /** Hard-delete all execs for an org. Returns count of deleted rows. */
  readonly deleteByOrgId: (
    orgId: string,
  ) => Effect.Effect<number, never, never>
}

export class ExecRepo extends Context.Tag('ExecRepo')<ExecRepo, ExecRepoApi>() {}
