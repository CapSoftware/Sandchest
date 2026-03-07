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
  GitCloneOptions,
  GitOperations,
  FindOptions,
  ReplaceOptions,
  ReplaceResult,
  SessionManager,
  ToolOperations,
  CreateSessionOptions,
} from './types.js'
import { Session } from './session.js'
import { ExecFailedError, TimeoutError } from './errors.js'
import { parseSSE, ExecStream } from './stream.js'

const WAIT_READY_DEFAULT_TIMEOUT = 120_000
const WAIT_READY_POLL_INTERVAL = 1_000
const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()
const VALIDATE_TAR_SCRIPT = `
import posixpath
import sys
import tarfile

archive = sys.argv[1]
bad = []

with tarfile.open(archive, 'r:gz') as tf:
    for member in tf.getmembers():
        normalized = posixpath.normpath(member.name)
        if member.name.startswith('/'):
            bad.append(f"absolute path: {member.name}")
            continue
        if normalized == '.':
            if not member.isdir():
                bad.append(f"non-directory root entry: {member.name}")
            continue
        if normalized == '..' or normalized.startswith('../'):
            bad.append(f"path traversal: {member.name}")
            continue
        if not (member.isfile() or member.isdir()):
            bad.append(f"unsupported type: {member.name} ({member.type!r})")
            continue
        if member.issym() or member.islnk():
            bad.append(f"link entry: {member.name}")
            continue

if bad:
    sys.stderr.write('Tarball contains unsafe entries: ' + ', '.join(bad[:5]))
    sys.exit(1)
`.trim()
const REPLACE_SCRIPT = `
import fnmatch
import os
import sys

MAX_FILE_SIZE = 10 * 1024 * 1024

search_file, replace_file, root = sys.argv[1], sys.argv[2], sys.argv[3]
glob_pat = sys.argv[4] if len(sys.argv) > 4 else None
with open(search_file) as f:
    search = f.read()
with open(replace_file) as f:
    repl = f.read()
real_root = os.path.realpath(root)
root_prefix = real_root if real_root.endswith(os.sep) else real_root + os.sep
count = 0

for dirpath, _, files in os.walk(root, followlinks=False):
    for name in files:
        fp = os.path.join(dirpath, name)
        if glob_pat and not fnmatch.fnmatch(name, glob_pat):
            continue
        try:
            if os.path.islink(fp):
                continue
            resolved = os.path.realpath(fp)
            if resolved != real_root and not resolved.startswith(root_prefix):
                continue
            if os.path.getsize(resolved) > MAX_FILE_SIZE:
                continue
            with open(resolved) as f:
                data = f.read()
            if search in data:
                with open(resolved, 'w') as f:
                    f.write(data.replace(search, repl))
                count += 1
                print(resolved, end='\\0')
        except (UnicodeDecodeError, PermissionError, OSError):
            pass

print(f'Replaced in {count} file(s)', file=sys.stderr)
`.trim()

function isScpStyleGitUrl(value: string): boolean {
  return /^[^@\s]+@[^:\s]+:.+$/.test(value)
}

function validateGitCloneUrl(rawUrl: string): { ok: true; url: string } | { ok: false; error: string } {
  const url = rawUrl.trim()
  if (url === '') {
    return { ok: false, error: 'Git URL must not be empty.' }
  }

  if (isScpStyleGitUrl(url)) {
    return { ok: true, url }
  }

  if (!url.includes('://')) {
    return {
      ok: false,
      error: `Invalid git URL: ${url}. Use an HTTPS URL or an SSH-style URL such as git@github.com:org/repo.git.`,
    }
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: `Invalid git URL: ${url}.` }
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error:
        'URLs with embedded credentials (user:pass@host) are not allowed. Private-repo auth is intentionally deferred until Sandchest can inject credentials outside the guest boundary.',
    }
  }

  return { ok: true, url }
}

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

  /** Git operations. */
  readonly git: GitOperations

  /** Session manager. */
  readonly session: SessionManager

  /** Exec-based helper tools. */
  readonly tools: ToolOperations

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
      write: async (path: string, content: string): Promise<void> => {
        await this.fs.upload(path, TEXT_ENCODER.encode(content))
      },
      uploadDir: async (path: string, tarball: Uint8Array): Promise<void> => {
        const tmpPath = `/tmp/.sandchest-upload-${crypto.randomUUID()}.tar.gz`
        await this._http.requestRaw({
          method: 'PUT',
          path: `/v1/sandboxes/${this.id}/files`,
          query: { path: tmpPath, batch: true },
          body: tarball,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
        try {
          const mkdirResult = await this._execSync(['mkdir', '-p', path], {
            operation: 'uploadDir:mkdir',
          })
          if (mkdirResult.exit_code !== 0) {
            throw new ExecFailedError({
              operation: 'uploadDir:mkdir',
              exitCode: mkdirResult.exit_code,
              stderr: mkdirResult.stderr,
            })
          }

          const validateResult = await this._execSync([
            'python3',
            '-c',
            VALIDATE_TAR_SCRIPT,
            tmpPath,
          ], {
            operation: 'uploadDir:verify',
          })
          if (validateResult.exit_code !== 0) {
            throw new ExecFailedError({
              operation: 'uploadDir:verify',
              exitCode: validateResult.exit_code,
              stderr: validateResult.stderr,
            })
          }

          const extractResult = await this._execSync([
            'tar',
            'xzf',
            tmpPath,
            '--no-same-owner',
            '-C',
            path,
          ], {
            operation: 'uploadDir:extract',
          })
          if (extractResult.exit_code !== 0) {
            throw new ExecFailedError({
              operation: 'uploadDir:extract',
              exitCode: extractResult.exit_code,
              stderr: extractResult.stderr,
            })
          }
        } finally {
          await this._execSync(['rm', '-f', tmpPath], {
            operation: 'uploadDir:cleanup',
          }).catch(() => {})
        }
      },
      download: async (path: string): Promise<Uint8Array> => {
        const res = await this._http.requestRaw({
          method: 'GET',
          path: `/v1/sandboxes/${this.id}/files`,
          query: { path },
        })
        return new Uint8Array(await res.arrayBuffer())
      },
      read: async (path: string): Promise<string> => {
        return TEXT_DECODER.decode(await this.fs.download(path))
      },
      downloadDir: async (path: string): Promise<Uint8Array> => {
        const tmpPath = `/tmp/.sandchest-download-${crypto.randomUUID()}.tar.gz`
        try {
          const archiveResult = await this._execSync(['tar', 'czf', tmpPath, '-C', path, '.'], {
            operation: 'downloadDir:archive',
          })
          if (archiveResult.exit_code !== 0) {
            throw new ExecFailedError({
              operation: 'downloadDir:archive',
              exitCode: archiveResult.exit_code,
              stderr: archiveResult.stderr,
            })
          }

          return await this.fs.download(tmpPath)
        } finally {
          await this._execSync(['rm', '-f', tmpPath], {
            operation: 'downloadDir:cleanup',
          }).catch(() => {})
        }
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

    this.git = {
      clone: async (url: string, options?: GitCloneOptions): Promise<ExecResult> => {
        const validated = validateGitCloneUrl(url)
        if (!validated.ok) {
          throw new ExecFailedError({
            operation: 'git.clone',
            exitCode: 1,
            stderr: validated.error,
          })
        }

        const dest = options?.dest ?? '/work'
        const cmd: string[] = ['git', 'clone']

        if (options?.branch) {
          if (options.branch.startsWith('-')) {
            throw new ExecFailedError({
              operation: 'git.clone',
              exitCode: 1,
              stderr: `Invalid branch name: '${options.branch}' — branch names must not start with '-'`,
            })
          }
          cmd.push('--branch', options.branch)
        }

        if (options?.depth !== undefined) {
          cmd.push('--depth', String(options.depth))
        }

        if (options?.singleBranch !== false) {
          cmd.push('--single-branch')
        }

        cmd.push('--', validated.url, dest)

        const result = await this._execSync(cmd, {
          operation: 'git.clone',
          timeout: options?.timeout ?? 120,
          env: {
            GIT_TERMINAL_PROMPT: '0',
            ...options?.env,
          },
        })

        if (result.exit_code !== 0) {
          throw new ExecFailedError({
            operation: 'git.clone',
            exitCode: result.exit_code,
            stderr: result.stderr,
          })
        }

        return {
          execId: result.exec_id,
          exitCode: result.exit_code,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.duration_ms,
        }
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

    this.tools = {
      find: async (path: string, pattern: string, options?: FindOptions): Promise<string[]> => {
        const cmd = ['find', '--', path]
        if (options?.maxDepth !== undefined) {
          cmd.push('-maxdepth', String(options.maxDepth))
        }
        if (options?.type) {
          cmd.push('-type', options.type)
        }
        cmd.push('-name', pattern)

        const result = await this._execSync(cmd, { operation: 'tools.find' })
        if (result.exit_code !== 0) {
          return []
        }
        return result.stdout.trim().split('\n').filter(Boolean)
      },
      replace: async (
        path: string,
        search: string,
        replacement: string,
        options?: ReplaceOptions,
      ): Promise<ReplaceResult> => {
        if (search.length === 0) {
          throw new ExecFailedError({
            operation: 'replace',
            exitCode: 1,
            stderr: 'search string must not be empty',
          })
        }

        const id = crypto.randomUUID()
        const searchPath = `/tmp/.sandchest-search-${id}`
        const replacePath = `/tmp/.sandchest-replace-${id}`

        try {
          await this.fs.upload(searchPath, TEXT_ENCODER.encode(search))
          await this.fs.upload(replacePath, TEXT_ENCODER.encode(replacement))

          const result = await this._execSync(
            [
              'python3',
              '-c',
              REPLACE_SCRIPT,
              searchPath,
              replacePath,
              path,
              ...(options?.glob ? [options.glob] : []),
            ],
            { operation: 'replace' },
          )

          if (result.exit_code !== 0) {
            throw new ExecFailedError({
              operation: 'replace',
              exitCode: result.exit_code,
              stderr: result.stderr,
            })
          }

          const changedPaths = result.stdout.split('\0').filter(Boolean)
          return {
            filesChanged: changedPaths.length,
            changedPaths,
          }
        } finally {
          for (const tempPath of [searchPath, replacePath]) {
            await this._execSync(['rm', '-f', tempPath], {
              operation: 'replace:cleanup',
            }).catch(() => {})
          }
        }
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

  private async _execSync(
    cmd: string[],
    options?: {
      operation?: string | undefined
      timeout?: number | undefined
      env?: Record<string, string> | undefined
    },
  ): Promise<ExecSyncResponse> {
    const result = await this._http.request<ExecSyncResponse>({
      method: 'POST',
      path: `/v1/sandboxes/${this.id}/exec`,
      body: {
        cmd,
        env: options?.env,
        timeout_seconds: options?.timeout ?? 30,
        wait: true,
      },
    })

    if (result.status !== 'done') {
      throw new ExecFailedError({
        operation: options?.operation ?? 'exec',
        exitCode: result.exit_code,
        stderr: result.stderr || `Command failed with status: ${result.status}`,
      })
    }

    return result
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
