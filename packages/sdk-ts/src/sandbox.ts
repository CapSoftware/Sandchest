import type {
  SandboxStatus,
  ExecStreamEvent,
  Artifact,
  FileEntry,
  ExecSyncResponse,
  ExecAsyncResponse,
  ForkSandboxResponse,
  GetForkTreeResponse,
  GetSandboxResponse,
  StopSandboxResponse,
  ListFilesResponse,
  RegisterArtifactsResponse,
  ListArtifactsResponse,
  CreateSessionResponse,
} from '@sandchest/contract'
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
import { Session } from './session.js'
import { TimeoutError } from './errors.js'
import { parseSSE, ExecStream } from './stream.js'

const WAIT_READY_DEFAULT_TIMEOUT = 120_000
const WAIT_READY_POLL_INTERVAL = 1_000

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
      upload: async (path: string, content: Uint8Array): Promise<void> => {
        await this._http.requestRaw({
          method: 'PUT',
          path: `/v1/sandboxes/${this.id}/files`,
          query: { path },
          body: content,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      },
      uploadDir: async (path: string, tarball: Uint8Array): Promise<void> => {
        await this._http.requestRaw({
          method: 'PUT',
          path: `/v1/sandboxes/${this.id}/files`,
          query: { path, batch: true },
          body: tarball,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      },
      download: async (path: string): Promise<Uint8Array> => {
        const res = await this._http.requestRaw({
          method: 'GET',
          path: `/v1/sandboxes/${this.id}/files`,
          query: { path },
        })
        return new Uint8Array(await res.arrayBuffer())
      },
      ls: async (path: string): Promise<FileEntry[]> => {
        const res = await this._http.request<ListFilesResponse>({
          method: 'GET',
          path: `/v1/sandboxes/${this.id}/files`,
          query: { path, list: true },
        })
        return res.files
      },
      rm: async (path: string): Promise<void> => {
        await this._http.request<{ ok: true }>({
          method: 'DELETE',
          path: `/v1/sandboxes/${this.id}/files`,
          query: { path },
        })
      },
    }

    this.artifacts = {
      register: async (paths: string[]): Promise<{ registered: number; total: number }> => {
        const res = await this._http.request<RegisterArtifactsResponse>({
          method: 'POST',
          path: `/v1/sandboxes/${this.id}/artifacts`,
          body: { paths },
        })
        return { registered: res.registered, total: res.total }
      },
      list: async (): Promise<Artifact[]> => {
        const res = await this._http.request<ListArtifactsResponse>({
          method: 'GET',
          path: `/v1/sandboxes/${this.id}/artifacts`,
        })
        return res.artifacts
      },
    }

    this.session = {
      create: async (options?: CreateSessionOptions): Promise<Session> => {
        const res = await this._http.request<CreateSessionResponse>({
          method: 'POST',
          path: `/v1/sandboxes/${this.id}/sessions`,
          body: {
            shell: options?.shell,
            env: options?.env,
          },
        })
        return new Session(res.session_id, this.id, this._http)
      },
    }
  }

  /** Execute a command (blocking, returns result). */
  exec(cmd: string | string[], options?: ExecOptions): Promise<ExecResult>
  /** Execute a command (streaming, returns ExecStream). */
  exec(cmd: string | string[], options: StreamExecOptions): Promise<ExecStream>
  exec(
    cmd: string | string[],
    options?: ExecOptions | StreamExecOptions,
  ): Promise<ExecResult> | Promise<ExecStream> {
    if (options && 'stream' in options && options.stream === true) {
      return this._execStream(cmd, options)
    }
    return this._execBlocking(cmd, options as ExecOptions | undefined)
  }

  /** Fork this sandbox's entire state into a new sandbox. */
  async fork(options?: ForkOptions): Promise<Sandbox> {
    const res = await this._http.request<ForkSandboxResponse>({
      method: 'POST',
      path: `/v1/sandboxes/${this.id}/fork`,
      body: {
        env: options?.env,
        ttl_seconds: options?.ttlSeconds,
      },
    })
    return new Sandbox(res.sandbox_id, res.status, res.replay_url, this._http)
  }

  /** Get the fork tree rooted at this sandbox. */
  async forks(): Promise<ForkTree> {
    const res = await this._http.request<GetForkTreeResponse>({
      method: 'GET',
      path: `/v1/sandboxes/${this.id}/forks`,
    })
    return { root: res.root, tree: res.tree }
  }

  /** Gracefully stop this sandbox (collects artifacts). */
  async stop(): Promise<void> {
    const res = await this._http.request<StopSandboxResponse>({
      method: 'POST',
      path: `/v1/sandboxes/${this.id}/stop`,
    })
    this.status = res.status
  }

  /** Hard stop and clean up this sandbox. */
  async destroy(): Promise<void> {
    await this._http.request<{ sandbox_id: string; status: 'deleted' }>({
      method: 'DELETE',
      path: `/v1/sandboxes/${this.id}`,
    })
    this.status = 'deleted'
  }

  /** Wait for this sandbox to reach 'running' status. */
  async waitReady(options?: { timeout?: number | undefined }): Promise<void> {
    const timeout = options?.timeout ?? WAIT_READY_DEFAULT_TIMEOUT
    const start = Date.now()

    while (true) {
      const res = await this._http.request<GetSandboxResponse>({
        method: 'GET',
        path: `/v1/sandboxes/${this.id}`,
      })

      this.status = res.status

      if (res.status === 'running') return

      if (res.status === 'failed' || res.status === 'deleted' || res.status === 'stopped') {
        throw new Error(`Sandbox ${this.id} reached terminal state: ${res.status}`)
      }

      if (Date.now() - start >= timeout) {
        throw new TimeoutError({
          message: `Sandbox ${this.id} did not become ready within ${timeout}ms`,
          timeoutMs: timeout,
        })
      }

      await new Promise((resolve) => setTimeout(resolve, WAIT_READY_POLL_INTERVAL))
    }
  }

  /** Auto-cleanup via Explicit Resource Management. Calls stop() if running. */
  async [Symbol.asyncDispose](): Promise<void> {
    if (this.status === 'running') {
      await this.stop()
    }
  }

  private async _execBlocking(
    cmd: string | string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    if (options?.onStdout || options?.onStderr) {
      return this._execWithCallbacks(cmd, options)
    }

    const res = await this._http.request<ExecSyncResponse>({
      method: 'POST',
      path: `/v1/sandboxes/${this.id}/exec`,
      body: {
        cmd,
        cwd: options?.cwd,
        env: options?.env,
        timeout_seconds: options?.timeout,
        wait: true,
      },
    })

    return {
      execId: res.exec_id,
      exitCode: res.exit_code,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs: res.duration_ms,
    }
  }

  private async _execWithCallbacks(
    cmd: string | string[],
    options: ExecOptions,
  ): Promise<ExecResult> {
    const asyncRes = await this._http.request<ExecAsyncResponse>({
      method: 'POST',
      path: `/v1/sandboxes/${this.id}/exec`,
      body: {
        cmd,
        cwd: options.cwd,
        env: options.env,
        timeout_seconds: options.timeout,
        wait: false,
      },
    })

    const response = await this._http.requestRaw({
      method: 'GET',
      path: `/v1/sandboxes/${this.id}/exec/${asyncRes.exec_id}/stream`,
      headers: { Accept: 'text/event-stream' },
    })

    let stdout = ''
    let stderr = ''
    let exitCode = 0
    let durationMs = 0

    for await (const event of parseSSE<ExecStreamEvent>(response)) {
      switch (event.t) {
        case 'stdout':
          stdout += event.data
          options.onStdout?.(event.data)
          break
        case 'stderr':
          stderr += event.data
          options.onStderr?.(event.data)
          break
        case 'exit':
          exitCode = event.code
          durationMs = event.duration_ms
          break
      }
    }

    return { execId: asyncRes.exec_id, exitCode, stdout, stderr, durationMs }
  }

  private async _execStream(
    cmd: string | string[],
    options: StreamExecOptions,
  ): Promise<ExecStream> {
    const asyncRes = await this._http.request<ExecAsyncResponse>({
      method: 'POST',
      path: `/v1/sandboxes/${this.id}/exec`,
      body: {
        cmd,
        cwd: options.cwd,
        env: options.env,
        timeout_seconds: options.timeout,
        wait: false,
      },
    })

    const response = await this._http.requestRaw({
      method: 'GET',
      path: `/v1/sandboxes/${this.id}/exec/${asyncRes.exec_id}/stream`,
      headers: { Accept: 'text/event-stream' },
    })

    return new ExecStream(asyncRes.exec_id, parseSSE<ExecStreamEvent>(response))
  }
}
