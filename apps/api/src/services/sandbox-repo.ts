import { Context, type Effect } from 'effect'
import type {
  ListSandboxesParams,
  ProfileName,
  SandboxStatus,
  FailureReason,
} from '@sandchest/contract'

/** Internal sandbox row representation. */
export interface SandboxRow {
  readonly id: Uint8Array
  readonly orgId: string
  readonly imageId: Uint8Array
  readonly profileId: Uint8Array
  readonly profileName: ProfileName
  readonly status: SandboxStatus
  readonly env: Record<string, string> | null
  readonly forkedFrom: Uint8Array | null
  readonly forkDepth: number
  readonly forkCount: number
  readonly ttlSeconds: number
  readonly failureReason: FailureReason | null
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly startedAt: Date | null
  readonly endedAt: Date | null
  readonly imageRef: string
}

export interface SandboxRepoApi {
  /** Look up image by string like "ubuntu-22.04" or "ubuntu-22.04/base". */
  readonly resolveImage: (
    imageStr: string,
  ) => Effect.Effect<{ id: Uint8Array; ref: string } | null, never, never>

  /** Look up profile by name. */
  readonly resolveProfile: (
    name: ProfileName,
  ) => Effect.Effect<{ id: Uint8Array } | null, never, never>

  /** Insert a new sandbox row and return it. */
  readonly create: (params: {
    id: Uint8Array
    orgId: string
    imageId: Uint8Array
    profileId: Uint8Array
    profileName: ProfileName
    env: Record<string, string> | null
    ttlSeconds: number
    imageRef: string
  }) => Effect.Effect<SandboxRow, never, never>

  /** Find a sandbox by id and orgId. */
  readonly findById: (
    id: Uint8Array,
    orgId: string,
  ) => Effect.Effect<SandboxRow | null, never, never>

  /** List sandboxes for an org with optional filters and cursor pagination. */
  readonly list: (
    orgId: string,
    params: ListSandboxesParams,
  ) => Effect.Effect<{ rows: SandboxRow[]; nextCursor: string | null }, never, never>

  /** Update sandbox status. Returns the updated row or null if not found. */
  readonly updateStatus: (
    id: Uint8Array,
    orgId: string,
    status: SandboxStatus,
    extra?: {
      endedAt?: Date
      failureReason?: FailureReason
    },
  ) => Effect.Effect<SandboxRow | null, never, never>

  /** Soft-delete a sandbox. Returns the updated row or null if not found. */
  readonly softDelete: (
    id: Uint8Array,
    orgId: string,
  ) => Effect.Effect<SandboxRow | null, never, never>

  /** Create a forked sandbox row. Sets forkedFrom and forkDepth from source. */
  readonly createFork: (params: {
    id: Uint8Array
    orgId: string
    source: SandboxRow
    env: Record<string, string> | null
    ttlSeconds: number
  }) => Effect.Effect<SandboxRow, never, never>

  /** Increment the fork count of a sandbox. Returns the updated row or null. */
  readonly incrementForkCount: (
    id: Uint8Array,
    orgId: string,
  ) => Effect.Effect<SandboxRow | null, never, never>

  /** Get all sandboxes in the fork tree containing the given sandbox. */
  readonly getForkTree: (
    id: Uint8Array,
    orgId: string,
  ) => Effect.Effect<SandboxRow[], never, never>
}

export class SandboxRepo extends Context.Tag('SandboxRepo')<SandboxRepo, SandboxRepoApi>() {}
