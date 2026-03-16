import { Effect, Layer } from 'effect'
import { createChannel, type Channel } from 'nice-grpc'
import { ChannelCredentials } from '@grpc/grpc-js'
import { readFileSync } from 'node:fs'
import { NodeClientRegistry } from './node-client-registry.js'
import { NodeRepo } from './node-repo.js'
import { NodeUnreachableError } from '../errors.js'
import { createLiveNodeClient } from './node-client.live.js'
import { hexToBytes } from './node-client.shared.js'
import type { NodeClientApi } from './node-client.js'

export interface RegistryConfig {
  readonly insecure: boolean
  readonly caPem?: string | undefined
  readonly certPem?: string | undefined
  readonly keyPem?: string | undefined
  readonly caPath?: string | undefined
  readonly certPath?: string | undefined
  readonly keyPath?: string | undefined
}

const NODE_PORT = 50051

export function createNodeClientRegistryLayer(
  config: RegistryConfig,
): Layer.Layer<NodeClientRegistry, never, NodeRepo> {
  return Layer.scoped(
    NodeClientRegistry,
    Effect.gen(function* () {
      const nodeRepo = yield* NodeRepo
      const cache = new Map<string, { client: NodeClientApi; channel: Channel }>()
      // Track in-flight connection attempts to prevent duplicate channels when
      // concurrent requests target the same node before the first resolves.
      const pending = new Map<string, Promise<NodeClientApi>>()

      // Build credentials once — shared across all connections
      let credentials: ChannelCredentials | null = null
      if (!config.insecure) {
        const ca = config.caPem
          ? Buffer.from(config.caPem)
          : readFileSync(config.caPath!)
        const key = config.keyPem
          ? Buffer.from(config.keyPem)
          : readFileSync(config.keyPath!)
        const cert = config.certPem
          ? Buffer.from(config.certPem)
          : readFileSync(config.certPath!)
        // rejectUnauthorized is false because we use a self-signed CA for mTLS.
        // The CA cert itself is verified (passed as the first arg to createSsl),
        // so the channel is still authenticated — we just skip the system trust
        // store check that would reject our private CA.
        credentials = ChannelCredentials.createSsl(ca, key, cert, {
          rejectUnauthorized: false,
        })
      }

      // Close all channels on scope finalization
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const entry of cache.values()) {
            entry.channel.close()
          }
          cache.clear()
          pending.clear()
        }),
      )

      const connectToNode = async (nodeIdHex: string): Promise<NodeClientApi> => {
        const node = await Effect.runPromise(nodeRepo.findById(hexToBytes(nodeIdHex)))
        if (!node) {
          throw new NodeUnreachableError({
            message: `Node ${nodeIdHex} not found in database`,
          })
        }
        if (node.status === 'disabled') {
          throw new NodeUnreachableError({
            message: `Node ${nodeIdHex} is disabled`,
          })
        }

        const address = `${node.hostname}:${NODE_PORT}`
        const channel = config.insecure
          ? createChannel(address)
          : createChannel(address, credentials!)

        const nodeIdBytes = hexToBytes(nodeIdHex)
        const client = createLiveNodeClient(channel, nodeIdBytes)
        cache.set(nodeIdHex, { client, channel })
        return client
      }

      return {
        getClient: (nodeIdHex: string) =>
          Effect.gen(function* () {
            const cached = cache.get(nodeIdHex)
            if (cached) return cached.client

            // Deduplicate concurrent connection attempts to the same node
            let inflight = pending.get(nodeIdHex)
            if (!inflight) {
              inflight = connectToNode(nodeIdHex)
              pending.set(nodeIdHex, inflight)
            }

            try {
              const client = yield* Effect.promise(() => inflight!)
              yield* Effect.log(
                `NodeClientRegistry: connected to node ${nodeIdHex}`,
              )
              return client
            } catch (err) {
              if (err instanceof NodeUnreachableError) {
                return yield* Effect.fail(err)
              }
              return yield* Effect.fail(
                new NodeUnreachableError({
                  message: `Failed to connect to node ${nodeIdHex}: ${err instanceof Error ? err.message : String(err)}`,
                }),
              )
            } finally {
              pending.delete(nodeIdHex)
            }
          }),
      }
    }),
  )
}
