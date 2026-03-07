import type {
  ProfileName,
  SandboxStatus,
  ForkTreeNode,
  Artifact,
  FileEntry,
} from '@sandchest/contract'
import type { Session } from './session.js'

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

export interface SandchestOptions {
  apiKey?: string | undefined
  baseUrl?: string | undefined
  timeout?: number | undefined
  retries?: number | undefined
}

// ---------------------------------------------------------------------------
// Sandbox options
// ---------------------------------------------------------------------------

export interface CreateSandboxOptions {
  image?: string | undefined
  profile?: ProfileName | undefined
  env?: Record<string, string> | undefined
  ttlSeconds?: number | undefined
  queueTimeoutSeconds?: number | undefined
  waitReady?: boolean | undefined
}

export interface ExecOptions {
  cwd?: string | undefined
  env?: Record<string, string> | undefined
  timeout?: number | undefined
  stream?: false | undefined
  onStdout?: ((data: string) => void) | undefined
  onStderr?: ((data: string) => void) | undefined
}

export interface StreamExecOptions {
  cwd?: string | undefined
  env?: Record<string, string> | undefined
  timeout?: number | undefined
  stream: true
}

export interface ForkOptions {
  env?: Record<string, string> | undefined
  ttlSeconds?: number | undefined
}

export interface GitCloneOptions {
  dest?: string | undefined
  branch?: string | undefined
  depth?: number | undefined
  /** Default: true (unlike git's default of false). Set to false to clone all branches. */
  singleBranch?: boolean | undefined
  env?: Record<string, string> | undefined
  /** Timeout in seconds (default: 120 for git clone). */
  timeout?: number | undefined
}

export interface ListSandboxesOptions {
  status?: SandboxStatus | undefined
  image?: string | undefined
  forkedFrom?: string | undefined
  cursor?: string | undefined
  limit?: number | undefined
}

// ---------------------------------------------------------------------------
// Session options
// ---------------------------------------------------------------------------

export interface CreateSessionOptions {
  shell?: string | undefined
  env?: Record<string, string> | undefined
}

export interface SessionExecOptions {
  timeout?: number | undefined
  wait?: boolean | undefined
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ExecResult {
  execId: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export interface ForkTree {
  root: string
  tree: ForkTreeNode[]
}

export interface FindOptions {
  type?: 'f' | 'd' | undefined
  maxDepth?: number | undefined
}

export interface ReplaceOptions {
  glob?: string | undefined
}

export interface ReplaceResult {
  filesChanged: number
  changedPaths: string[]
}

// ---------------------------------------------------------------------------
// Sub-resource operation interfaces
// ---------------------------------------------------------------------------

export interface FileOperations {
  upload(path: string, content: Uint8Array): Promise<void>
  /** Write a UTF-8 text file. */
  write(path: string, content: string): Promise<void>
  uploadDir(path: string, tarball: Uint8Array): Promise<void>
  download(path: string): Promise<Uint8Array>
  /** Read a UTF-8 text file. */
  read(path: string): Promise<string>
  /** Download a directory as a gzipped tarball. */
  downloadDir(path: string): Promise<Uint8Array>
  ls(path: string): Promise<FileEntry[]>
  rm(path: string): Promise<void>
}

export interface ArtifactOperations {
  register(paths: string[]): Promise<{ registered: number; total: number }>
  list(): Promise<Artifact[]>
}

export interface GitOperations {
  clone(url: string, options?: GitCloneOptions): Promise<ExecResult>
}

export interface SessionManager {
  create(options?: CreateSessionOptions): Promise<Session>
}

export interface ToolOperations {
  find(path: string, pattern: string, options?: FindOptions): Promise<string[]>
  replace(
    path: string,
    search: string,
    replacement: string,
    options?: ReplaceOptions,
  ): Promise<ReplaceResult>
}
