import { Context, type Effect } from 'effect'

/** Minimal org row for hard-delete processing. */
export interface OrgRow {
  readonly id: string
  readonly deletedAt: Date
}

export interface OrgRepoApi {
  /** Find orgs soft-deleted before the given cutoff. */
  readonly findSoftDeletedBefore: (
    cutoff: Date,
  ) => Effect.Effect<OrgRow[], never, never>

  /** Hard-delete an org's quota row. */
  readonly deleteQuota: (
    orgId: string,
  ) => Effect.Effect<number, never, never>

  /** Hard-delete an org's usage rows. */
  readonly deleteUsage: (
    orgId: string,
  ) => Effect.Effect<number, never, never>

  /** Hard-delete the org record itself. */
  readonly deleteOrg: (
    orgId: string,
  ) => Effect.Effect<void, never, never>
}

export class OrgRepo extends Context.Tag('OrgRepo')<OrgRepo, OrgRepoApi>() {}
