/**
 * A disposable environment holding one shallow checkout for the duration of
 * one scan. Created, used and destroyed by a single scan; never shared.
 */
export interface Workspace extends AsyncDisposable {
  /** Absolute path of the checkout inside the workspace. */
  readonly root: string;
  /** Fetches `repo` into `root`. Call once, before anything else. */
  clone(repo: RepoRef, options: CloneOptions): Promise<void>;
  /** Runs a command in `root`. A non-zero exit code is returned, not thrown. */
  exec(cmd: string[], options?: ExecOptions): Promise<ExecResult>;
  /** Reads a UTF-8 file by checkout-relative path. Refuses paths that resolve outside the checkout. */
  readFile(path: string): Promise<string>;
  /** Stops anything still running and deletes everything. Idempotent. */
  destroy(): Promise<void>;
}

export interface RepoRef {
  /** `https://` clone URL. `file://` is accepted for local evals and tests. */
  url: string;
  /** Branch, tag or commit SHA. Defaults to the remote's HEAD. */
  ref?: string;
}

export interface CloneOptions {
  depth: number;
  filter?: "blob:none";
  /** Short-lived installation token. Sent only to the repo's host and never written to disk. */
  token?: string;
  timeoutMs?: number;
}

export interface ExecOptions {
  /** Kills the command, and anything it spawned, after this long. */
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  /** Exit status; `128 + signal` if the process was killed. */
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";
}
