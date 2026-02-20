import { Effect, Layer } from 'effect'
import { NodeClient, type NodeClientApi } from './node-client.js'

export function createInMemoryNodeClient(): NodeClientApi {
  const files = new Map<string, Uint8Array>()

  function fileKey(sandboxId: Uint8Array, path: string): string {
    return `${Array.from(sandboxId).join(',')}:${path}`
  }

  return {
    exec: () =>
      Effect.succeed({
        exitCode: 0,
        stdout: '',
        stderr: '',
        cpuMs: 1,
        peakMemoryBytes: 1024,
        durationMs: 5,
      }),

    createSession: () => Effect.void,

    sessionExec: () =>
      Effect.succeed({
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 3,
      }),

    sessionInput: () => Effect.void,

    destroySession: () => Effect.void,

    putFile: ({ sandboxId, path, data }) =>
      Effect.sync(() => {
        files.set(fileKey(sandboxId, path), data)
        return { bytesWritten: data.length }
      }),

    getFile: ({ sandboxId, path }) =>
      Effect.sync(() => {
        return files.get(fileKey(sandboxId, path)) ?? new Uint8Array(0)
      }),

    listFiles: ({ sandboxId, path }) =>
      Effect.sync(() => {
        const prefix = fileKey(sandboxId, path)
        const entries: Array<{
          name: string
          path: string
          type: 'file' | 'directory'
          sizeBytes: number | null
        }> = []
        for (const [key, data] of files) {
          if (key.startsWith(prefix)) {
            const filePath = key.split(':').slice(1).join(':')
            const name = filePath.split('/').pop() ?? filePath
            entries.push({
              name,
              path: filePath,
              type: 'file',
              sizeBytes: data.length,
            })
          }
        }
        return entries
      }),

    deleteFile: ({ sandboxId, path }) =>
      Effect.sync(() => {
        const prefix = fileKey(sandboxId, path)
        for (const key of files.keys()) {
          if (key === prefix || key.startsWith(prefix + '/')) {
            files.delete(key)
          }
        }
      }),
  }
}

export const NodeClientMemory = Layer.sync(NodeClient, createInMemoryNodeClient)
