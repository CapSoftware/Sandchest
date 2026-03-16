import { Context, Effect } from 'effect'
import type { NodeClientApi } from './node-client.js'
import { NodeUnreachableError, NodeNotAssignedError } from '../errors.js'
import { bytesToHex } from './node-client.shared.js'
import type { SandboxRow } from './sandbox-repo.js'

export interface NodeClientRegistryApi {
  /** Get gRPC client for a node by hex ID. Lazily creates connection. */
  readonly getClient: (
    nodeIdHex: string,
  ) => Effect.Effect<NodeClientApi, NodeUnreachableError>
}

export class NodeClientRegistry extends Context.Tag('NodeClientRegistry')<
  NodeClientRegistry,
  NodeClientRegistryApi
>() {}

/** Resolve the node client for a sandbox that already has a nodeId assigned. */
export function getClientForSandbox(
  sandbox: SandboxRow,
): Effect.Effect<
  NodeClientApi,
  NodeUnreachableError | NodeNotAssignedError,
  NodeClientRegistry
> {
  return Effect.gen(function* () {
    if (!sandbox.nodeId) {
      return yield* Effect.fail(
        new NodeNotAssignedError({
          message: 'Sandbox has no assigned node',
        }),
      )
    }
    const registry = yield* NodeClientRegistry
    return yield* registry.getClient(bytesToHex(sandbox.nodeId))
  })
}
