import { Effect, Layer } from 'effect'
import { NodeClientRegistry } from './node-client-registry.js'
import type { NodeClientApi } from './node-client.js'
import { createInMemoryNodeClient } from './node-client.memory.js'

/**
 * In-memory registry for testing. Uses a single shared client by default,
 * or a provided map for multi-node simulation.
 */
export function createNodeClientRegistryMemory(
  clients?: Map<string, NodeClientApi>,
): Layer.Layer<NodeClientRegistry> {
  return Layer.succeed(NodeClientRegistry, {
    getClient: (nodeIdHex: string) => {
      if (clients) {
        const client = clients.get(nodeIdHex)
        if (client) return Effect.succeed(client)
        return Effect.succeed(createInMemoryNodeClient())
      }
      return Effect.succeed(createInMemoryNodeClient())
    },
  })
}

/** Default in-memory registry with a single shared client. */
export const NodeClientRegistryMemory: Layer.Layer<NodeClientRegistry> =
  createNodeClientRegistryMemory()
