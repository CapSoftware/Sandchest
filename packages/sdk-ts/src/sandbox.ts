import type { SandboxStatus, ExecStreamEvent, Artifact, FileEntry } from '@sandchest/contract'
import type { HttpClient } from './http.js'
import type {
  ExecOptions,
  StreamExecOptions,
  ExecResult,
  ForkOptions,
  ForkTree,
  FileOperations,
  ArtifactOperations,
  SessionManager,
  CreateSessionOptions,
} from './types.js'
import type { Session } from './session.js'

/**
 * A Sandchest sandbox — an isolated Firecracker microVM.
 * All operations hang off this instance. No ID passing needed.
 */
export class Sandbox {
  readonly id: string
  status: SandboxStatus
  readonly replayUrl: string
  /** @internal */
  readonly _http: HttpClient

  /** File system operations. */
  readonly fs: FileOperations

  /** Artifact operations. */
  readonly artifacts: ArtifactOperations

  /** Session manager. */
  readonly session: SessionManager

  /** @internal — Use `sandchest.create()` or `sandchest.get()` instead. */
  constructor(id: string, status: SandboxStatus, replayUrl: string, http: HttpClient) {
    this.id = id
    this.status = status
    this.replayUrl = replayUrl
    this._http = http

    this.fs = {
      upload: (_path: string, _content: Uint8Array): Promise<void> => {
        throw new Error('Not implemented: Sandbox.fs.upload')
      },
      uploadDir: (_path: string, _tarball: Uint8Array): Promise<void> => {
        throw new Error('Not implemented: Sandbox.fs.uploadDir')
      },
      download: (_path: string): Promise<Uint8Array> => {
        throw new Error('Not implemented: Sandbox.fs.download')
      },
      ls: (_path: string): Promise<FileEntry[]> => {
        throw new Error('Not implemented: Sandbox.fs.ls')
      },
      rm: (_path: string): Promise<void> => {
        throw new Error('Not implemented: Sandbox.fs.rm')
      },
    }

    this.artifacts = {
      register: (_paths: string[]): Promise<{ registered: number; total: number }> => {
        throw new Error('Not implemented: Sandbox.artifacts.register')
      },
      list: (): Promise<Artifact[]> => {
        throw new Error('Not implemented: Sandbox.artifacts.list')
      },
    }

    this.session = {
      create: (_options?: CreateSessionOptions): Promise<Session> => {
        throw new Error('Not implemented: Sandbox.session.create')
      },
    }
  }

  /** Execute a command (blocking, returns result). */
  exec(cmd: string | string[], options?: ExecOptions): Promise<ExecResult>
  /** Execute a command (streaming, returns async iterable of events). */
  exec(cmd: string | string[], options: StreamExecOptions): AsyncIterable<ExecStreamEvent>
  exec(
    _cmd: string | string[],
    _options?: ExecOptions | StreamExecOptions,
  ): Promise<ExecResult> | AsyncIterable<ExecStreamEvent> {
    throw new Error('Not implemented: Sandbox.exec')
  }

  /** Fork this sandbox's entire state into a new sandbox. */
  async fork(_options?: ForkOptions): Promise<Sandbox> {
    throw new Error('Not implemented: Sandbox.fork')
  }

  /** Get the fork tree rooted at this sandbox. */
  async forks(): Promise<ForkTree> {
    throw new Error('Not implemented: Sandbox.forks')
  }

  /** Gracefully stop this sandbox (collects artifacts). */
  async stop(): Promise<void> {
    throw new Error('Not implemented: Sandbox.stop')
  }

  /** Hard stop and clean up this sandbox. */
  async destroy(): Promise<void> {
    throw new Error('Not implemented: Sandbox.destroy')
  }

  /** Wait for this sandbox to reach 'running' status. */
  async waitReady(_options?: { timeout?: number | undefined }): Promise<void> {
    throw new Error('Not implemented: Sandbox.waitReady')
  }

  /** Auto-cleanup via Explicit Resource Management. Calls stop(). */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop()
  }
}
