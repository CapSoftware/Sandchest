import { Effect, Layer } from 'effect'
import { NodeLookup, type SchedulerNode } from './scheduler.js'
import { NodeRepo } from './node-repo.js'
import { bytesToHex } from './node-client.shared.js'

/** Live implementation that reads online nodes from the DB via NodeRepo. */
export const NodeLookupLive: Layer.Layer<NodeLookup, never, NodeRepo> = Layer.effect(
  NodeLookup,
  Effect.gen(function* () {
    const nodeRepo = yield* NodeRepo

    return {
      getOnlineNodes: () =>
        Effect.gen(function* () {
          const rows = yield* nodeRepo.list()
          return rows
            .filter((r) => r.status === 'online')
            .map(
              (r): SchedulerNode => ({
                id: bytesToHex(r.id),
                slotsTotal: r.slotsTotal,
                status: r.status,
              }),
            )
        }),
    }
  }),
)

/** In-memory implementation for tests. Wraps a static node list. */
export function createNodeLookupMemory(
  nodes: SchedulerNode[],
): Layer.Layer<NodeLookup> {
  return Layer.succeed(NodeLookup, {
    getOnlineNodes: () => Effect.succeed(nodes),
  })
}
