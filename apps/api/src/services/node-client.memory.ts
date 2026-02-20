import { Effect, Layer } from 'effect'
import { NodeClient, type NodeClientApi } from './node-client.js'

export function createInMemoryNodeClient(): NodeClientApi {
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
  }
}

export const NodeClientMemory = Layer.sync(NodeClient, createInMemoryNodeClient)
