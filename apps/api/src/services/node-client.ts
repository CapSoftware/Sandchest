import { Context, type Effect } from 'effect'

/** Result of executing a command on a node. */
export interface NodeExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly cpuMs: number
  readonly peakMemoryBytes: number
  readonly durationMs: number
}

export interface NodeClientApi {
  /** Execute a command on the node hosting the sandbox. */
  readonly exec: (params: {
    sandboxId: Uint8Array
    execId: string
    cmd: string[]
    cwd: string
    env: Record<string, string>
    timeoutSeconds: number
  }) => Effect.Effect<NodeExecResult, never, never>
}

export class NodeClient extends Context.Tag('NodeClient')<NodeClient, NodeClientApi>() {}
