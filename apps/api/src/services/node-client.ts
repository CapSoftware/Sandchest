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

/** Result of a session exec on a node. */
export interface NodeSessionExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

/** File entry returned from node file listing. */
export interface NodeFileEntry {
  readonly name: string
  readonly path: string
  readonly type: 'file' | 'directory'
  readonly sizeBytes: number | null
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

  /** Create a session on the node. */
  readonly createSession: (params: {
    sandboxId: Uint8Array
    sessionId: string
    shell: string
    env: Record<string, string>
  }) => Effect.Effect<void, never, never>

  /** Execute a command in an existing session. */
  readonly sessionExec: (params: {
    sandboxId: Uint8Array
    sessionId: string
    cmd: string
    timeoutSeconds: number
  }) => Effect.Effect<NodeSessionExecResult, never, never>

  /** Send raw stdin input to a session. */
  readonly sessionInput: (params: {
    sandboxId: Uint8Array
    sessionId: string
    data: string
  }) => Effect.Effect<void, never, never>

  /** Destroy a session on the node. */
  readonly destroySession: (params: {
    sandboxId: Uint8Array
    sessionId: string
  }) => Effect.Effect<void, never, never>

  /** Upload a file to the sandbox. Returns bytes written. */
  readonly putFile: (params: {
    sandboxId: Uint8Array
    path: string
    data: Uint8Array
  }) => Effect.Effect<{ bytesWritten: number }, never, never>

  /** Download a file from the sandbox. */
  readonly getFile: (params: {
    sandboxId: Uint8Array
    path: string
  }) => Effect.Effect<Uint8Array, never, never>

  /** List files in a directory on the sandbox. */
  readonly listFiles: (params: {
    sandboxId: Uint8Array
    path: string
  }) => Effect.Effect<NodeFileEntry[], never, never>

  /** Delete a file or directory on the sandbox. */
  readonly deleteFile: (params: {
    sandboxId: Uint8Array
    path: string
  }) => Effect.Effect<void, never, never>
}

export class NodeClient extends Context.Tag('NodeClient')<NodeClient, NodeClientApi>() {}
