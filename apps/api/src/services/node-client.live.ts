import { Effect, Layer } from 'effect'
import { createChannel, createClient, type Channel } from 'nice-grpc'
import { ChannelCredentials } from '@grpc/grpc-js'
import { readFileSync } from 'node:fs'
import { nodeRpc } from '@sandchest/contract'
import type { NodeClientApi, NodeFileEntry, CollectedArtifact, ProvisionedImage } from './node-client.js'
import { NodeClient } from './node-client.js'
import { bytesToHex, hexToBytes } from './node-client.shared.js'

/** Max chunk size for file streaming (64 KB). */
const CHUNK_SIZE = 64 * 1024

export interface NodeGrpcConfig {
  /** gRPC address, e.g. "node1.sandchest.com:50051". */
  readonly address: string
  /** Node ID as a 32-char hex string (16-byte UUID). */
  readonly nodeId: string
  /** Allow plaintext localhost gRPC for local development. */
  readonly insecure?: boolean | undefined
  /** Path to client certificate PEM file (local dev). */
  readonly certPath?: string | undefined
  /** Path to client private key PEM file (local dev). */
  readonly keyPath?: string | undefined
  /** Path to CA certificate PEM file (local dev). */
  readonly caPath?: string | undefined
  /** CA certificate PEM content (Fly.io secrets). */
  readonly caPem?: string | undefined
  /** Client certificate PEM content (Fly.io secrets). */
  readonly certPem?: string | undefined
  /** Client private key PEM content (Fly.io secrets). */
  readonly keyPem?: string | undefined
}

export function createLiveNodeClient(channel: Channel, nodeIdBytes: Uint8Array): NodeClientApi {
  const client = createClient(nodeRpc.NodeDefinition, channel)

  return {
    nodeId: nodeIdBytes,

    createSandbox: (params) =>
      Effect.promise(async () => {
        await client.createSandbox({
          sandboxId: bytesToHex(params.sandboxId),
          kernelRef: params.kernelRef,
          rootfsRef: params.rootfsRef,
          cpuCores: params.cpuCores,
          memoryMb: params.memoryMb,
          diskGb: params.diskGb,
          env: params.env,
          ttlSeconds: params.ttlSeconds,
        })
      }),

    exec: (params) =>
      Effect.promise(async () => {
        let stdout = ''
        let stderr = ''
        let exitCode = 0
        let cpuMs = 0
        let peakMemoryBytes = 0
        let durationMs = 0

        for await (const event of client.exec({
          sandboxId: bytesToHex(params.sandboxId),
          execId: params.execId,
          cmd: params.cmd,
          shellCmd: '',
          cwd: params.cwd,
          env: params.env,
          timeoutSeconds: params.timeoutSeconds,
        })) {
          if (event.stdout) stdout += Buffer.from(event.stdout).toString('utf-8')
          if (event.stderr) stderr += Buffer.from(event.stderr).toString('utf-8')
          if (event.exit) {
            exitCode = event.exit.exitCode
            cpuMs = event.exit.cpuMs
            peakMemoryBytes = event.exit.peakMemoryBytes
            durationMs = event.exit.durationMs
          }
        }

        return { exitCode, stdout, stderr, cpuMs, peakMemoryBytes, durationMs }
      }),

    createSession: (params) =>
      Effect.promise(async () => {
        await client.createSession({
          sandboxId: bytesToHex(params.sandboxId),
          sessionId: params.sessionId,
          shell: params.shell,
          env: params.env,
        })
      }),

    sessionExec: (params) =>
      Effect.promise(async () => {
        let stdout = ''
        let stderr = ''
        let exitCode = 0
        let durationMs = 0

        for await (const event of client.sessionExec({
          sandboxId: bytesToHex(params.sandboxId),
          sessionId: params.sessionId,
          execId: '',
          cmd: params.cmd,
          timeoutSeconds: params.timeoutSeconds,
        })) {
          if (event.stdout) stdout += Buffer.from(event.stdout).toString('utf-8')
          if (event.stderr) stderr += Buffer.from(event.stderr).toString('utf-8')
          if (event.exit) {
            exitCode = event.exit.exitCode
            durationMs = event.exit.durationMs
          }
        }

        return { exitCode, stdout, stderr, durationMs }
      }),

    sessionInput: (params) =>
      Effect.promise(async () => {
        await client.sessionInput({
          sandboxId: bytesToHex(params.sandboxId),
          sessionId: params.sessionId,
          data: Buffer.from(params.data, 'utf-8'),
        })
      }),

    destroySession: (params) =>
      Effect.promise(async () => {
        await client.destroySession({
          sandboxId: bytesToHex(params.sandboxId),
          sessionId: params.sessionId,
        })
      }),

    putFile: (params) =>
      Effect.promise(async () => {
        const sandboxId = bytesToHex(params.sandboxId)
        const { data } = params

        async function* chunks() {
          if (data.length === 0) {
            yield { sandboxId, path: params.path, data: Buffer.alloc(0), offset: 0, done: true }
            return
          }
          for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
            const end = Math.min(offset + CHUNK_SIZE, data.length)
            yield {
              sandboxId,
              path: params.path,
              data: Buffer.from(data.subarray(offset, end)),
              offset,
              done: end >= data.length,
            }
          }
        }

        const response = await client.putFile(chunks())
        return { bytesWritten: Number(response.bytesWritten) }
      }),

    getFile: (params) =>
      Effect.promise(async () => {
        const buffers: Buffer[] = []
        for await (const chunk of client.getFile({
          sandboxId: bytesToHex(params.sandboxId),
          path: params.path,
        })) {
          if (chunk.data.length > 0) {
            buffers.push(Buffer.from(chunk.data))
          }
        }
        return Buffer.concat(buffers)
      }),

    listFiles: (params) =>
      Effect.promise(async () => {
        const response = await client.listFiles({
          sandboxId: bytesToHex(params.sandboxId),
          path: params.path,
        })
        return response.files.map(
          (f): NodeFileEntry => ({
            name: f.path.split('/').pop() ?? f.path,
            path: f.path,
            type: f.isDir ? 'directory' : 'file',
            sizeBytes: f.size > 0 ? Number(f.size) : null,
          }),
        )
      }),

    deleteFile: () =>
      Effect.die(new Error('deleteFile is not implemented in the gRPC Node service proto')),

    forkSandbox: (params) =>
      Effect.promise(async () => {
        await client.forkSandbox({
          sourceSandboxId: bytesToHex(params.sourceSandboxId),
          newSandboxId: bytesToHex(params.newSandboxId),
        })
      }),

    collectArtifacts: (params) =>
      Effect.promise(async () => {
        const response = await client.collectArtifacts({
          sandboxId: bytesToHex(params.sandboxId),
          paths: params.paths,
        })
        return response.artifacts.map(
          (a): CollectedArtifact => ({
            name: a.name,
            mime: a.mime,
            bytes: Number(a.bytes),
            sha256: a.sha256,
            ref: a.ref,
          }),
        )
      }),

    stopSandbox: (params) =>
      Effect.promise(async () => {
        await client.stopSandbox({
          sandboxId: bytesToHex(params.sandboxId),
        })
      }),

    destroySandbox: (params) =>
      Effect.promise(async () => {
        await client.destroySandbox({
          sandboxId: bytesToHex(params.sandboxId),
        })
      }),

    provisionImages: (params) =>
      Effect.promise(async () => {
        // nice-grpc type inference truncates with many methods; cast needed
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nice-grpc drops method types beyond ~10 on the generated client
        const provisionFn = (client as any).provisionImages as (req: {
          imageRefs: string[]
        }) => Promise<{ images: Array<{ imageRef: string; status: string; error: string }> }>
        const response = await provisionFn({ imageRefs: params.imageRefs })
        return response.images.map(
          (img): ProvisionedImage => ({
            imageRef: img.imageRef,
            status: img.status,
            error: img.error,
          }),
        )
      }),
  }
}

export function createNodeClientLayer(config: NodeGrpcConfig): Layer.Layer<NodeClient> {
  return Layer.scoped(
    NodeClient,
    Effect.gen(function* () {
      let channel: Channel

      if (config.insecure) {
        yield* Effect.log(`gRPC insecure: target=${config.address}`)
        channel = createChannel(config.address)
      } else {
        // Prefer PEM content from env vars (Fly.io), fall back to file paths (local dev)
        const ca = config.caPem ? Buffer.from(config.caPem) : readFileSync(config.caPath!)
        const key = config.keyPem ? Buffer.from(config.keyPem) : readFileSync(config.keyPath!)
        const cert = config.certPem ? Buffer.from(config.certPem) : readFileSync(config.certPath!)

        yield* Effect.log(
          `gRPC mTLS: ca=${ca.length}B key=${key.length}B cert=${cert.length}B target=${config.address}`,
        )

        // Bun's tls.connect polyfill does not properly apply custom CA
        // certificates from secureContext when upgrading an existing TCP
        // socket to TLS (the pattern @grpc/grpc-js uses). This causes
        // "unable to verify the first certificate" even with valid certs.
        // Workaround: skip client-side server cert verification. The server
        // still verifies our client cert (mTLS), and we connect to a known
        // IP we control, so MITM risk is minimal.
        const credentials = ChannelCredentials.createSsl(ca, key, cert, {
          rejectUnauthorized: false,
        })
        channel = createChannel(config.address, credentials)
      }

      const nodeIdBytes = hexToBytes(config.nodeId)

      yield* Effect.addFinalizer(() => Effect.sync(() => channel.close()))

      return createLiveNodeClient(channel, nodeIdBytes)
    }),
  )
}
