import { Context, type Effect } from 'effect'

/** Internal node row representation. */
export interface NodeRow {
  readonly id: Uint8Array
  readonly name: string
  readonly hostname: string
  readonly slotsTotal: number
  readonly status: 'online' | 'offline' | 'draining' | 'disabled'
  readonly version: string | null
  readonly firecrackerVersion: string | null
  readonly capabilities: unknown
  readonly lastSeenAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface NodeRepoApi {
  readonly list: () => Effect.Effect<NodeRow[], never, never>

  readonly findById: (id: Uint8Array) => Effect.Effect<NodeRow | null, never, never>

  readonly create: (params: {
    id: Uint8Array
    name: string
    hostname: string
    slotsTotal: number
    status: 'online' | 'offline' | 'draining' | 'disabled'
    version: string | null
    firecrackerVersion: string | null
  }) => Effect.Effect<void, never, never>

  readonly update: (
    id: Uint8Array,
    fields: {
      status?: 'online' | 'offline' | 'draining' | 'disabled' | undefined
      slotsTotal?: number | undefined
      version?: string | undefined
      firecrackerVersion?: string | undefined
    },
  ) => Effect.Effect<void, never, never>

  readonly remove: (id: Uint8Array) => Effect.Effect<void, never, never>

  readonly countActiveSandboxes: (nodeId: Uint8Array) => Effect.Effect<number, never, never>

  readonly touchLastSeen: (id: Uint8Array) => Effect.Effect<void, never, never>
}

export class NodeRepo extends Context.Tag('NodeRepo')<NodeRepo, NodeRepoApi>() {}
