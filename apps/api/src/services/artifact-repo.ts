import { Context, type Effect } from 'effect'

/** Internal artifact row representation. */
export interface ArtifactRow {
  readonly id: Uint8Array
  readonly sandboxId: Uint8Array
  readonly orgId: string
  readonly execId: Uint8Array | null
  readonly name: string
  readonly mime: string
  readonly bytes: number
  readonly sha256: string
  readonly ref: string
  readonly createdAt: Date
  readonly retentionUntil: Date | null
}

export interface ArtifactRepoApi {
  /** Insert a new artifact row and return it. */
  readonly create: (params: {
    id: Uint8Array
    sandboxId: Uint8Array
    orgId: string
    execId?: Uint8Array | undefined
    name: string
    mime: string
    bytes: number
    sha256: string
    ref: string
    retentionUntil?: Date | undefined
  }) => Effect.Effect<ArtifactRow, never, never>

  /** Find an artifact by id, scoped to sandbox and org. */
  readonly findById: (
    id: Uint8Array,
    sandboxId: Uint8Array,
    orgId: string,
  ) => Effect.Effect<ArtifactRow | null, never, never>

  /** List artifacts for a sandbox with cursor pagination. */
  readonly list: (
    sandboxId: Uint8Array,
    orgId: string,
    params: {
      cursor?: string | undefined
      limit?: number | undefined
    },
  ) => Effect.Effect<{ rows: ArtifactRow[]; nextCursor: string | null }, never, never>

  /** Count artifacts for a sandbox. */
  readonly count: (
    sandboxId: Uint8Array,
    orgId: string,
  ) => Effect.Effect<number, never, never>

  /** Find artifacts past their retention date. */
  readonly findExpiredRetention: (
    before: Date,
  ) => Effect.Effect<ArtifactRow[], never, never>

  /** Delete artifacts by IDs. Returns count of deleted rows. */
  readonly deleteByIds: (
    ids: Uint8Array[],
  ) => Effect.Effect<number, never, never>

  /** Find all artifacts for an org. Used by cascade deletion. */
  readonly findByOrgId: (
    orgId: string,
  ) => Effect.Effect<ArtifactRow[], never, never>

  /** Hard-delete all artifacts for an org. Returns count of deleted rows. */
  readonly deleteByOrgId: (
    orgId: string,
  ) => Effect.Effect<number, never, never>
}

export class ArtifactRepo extends Context.Tag('ArtifactRepo')<ArtifactRepo, ArtifactRepoApi>() {}
