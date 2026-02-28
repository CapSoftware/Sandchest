import { Effect, Layer } from 'effect'
import { createChannel, createClient, type Channel } from 'nice-grpc'
import { ChannelCredentials } from '@grpc/grpc-js'
import { readFileSync } from 'node:fs'
import { nodeRpc } from '@sandchest/contract'
import type { NodeClientApi, NodeFileEntry, CollectedArtifact } from './node-client.js'
import { NodeClient } from './node-client.js'

/** Max chunk size for file streaming (64 KB). */
const CHUNK_SIZE = 64 * 1024

/** Convert 16-byte UUID to hex string for gRPC wire format. */
export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

export interface NodeGrpcConfig {
  /** gRPC address, e.g. "node1.sandchest.com:50051". */
  readonly address: string
  /** Path to client certificate PEM file. */
  readonly certPath: string
  /** Path to client private key PEM file. */
  readonly keyPath: string
  /** Path to CA certificate PEM file. */
  readonly caPath: string
  /** Node ID as a 32-char hex string (16-byte UUID). */
  readonly nodeId: string
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
  }
}

/** Convert a 32-char hex string to a 16-byte Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'))
}

export function createNodeClientLayer(config: NodeGrpcConfig): Layer.Layer<NodeClient> {
  return Layer.scoped(
    NodeClient,
    Effect.gen(function* () {
      const cert = readFileSync(config.certPath)
      const key = readFileSync(config.keyPath)
      const ca = readFileSync(config.caPath)

      const credentials = ChannelCredentials.createSsl(ca, key, cert)
      const channel = createChannel(config.address, credentials)
      const nodeIdBytes = hexToBytes(config.nodeId)

      yield* Effect.addFinalizer(() => Effect.sync(() => channel.close()))

      return createLiveNodeClient(channel, nodeIdBytes)
    }),
  )
}
