/**
 * The power dynamic validation needs on top of the read-only indexer: run
 * commands in the checkout and read files back. It is deliberately the
 * smallest surface that lets the engine boot the app and probe it, so the
 * `workspace` package's `Workspace` satisfies it as-is (cloud sandbox or local
 * folder) with no adapter.
 *
 * A scan given no `Runtime` simply skips validation: every finding ships
 * exactly as the skeptic left it. Validation is never allowed to *remove*
 * trust — see `validate.ts` — so running without one only forgoes the
 * "verified" badge, never a finding.
 */
export interface Runtime {
  /**
   * Runs a command in the checkout root. A non-zero exit is returned, not
   * thrown. The caller keeps all attack traffic on the VM's own loopback, so
   * nothing a probe sends ever leaves the disposable workspace.
   */
  exec(cmd: string[], options?: RuntimeExecOptions): Promise<RuntimeExecResult>;
  /** Reads a UTF-8 file by checkout-relative path. */
  readFile(path: string): Promise<string>;
  /**
   * Launches a long-running process — an app server — that keeps running after
   * this resolves, and resolves as soon as it has started (not when it exits).
   * Tearing the workspace down stops it, so nothing leaks. When a runtime does
   * not provide it, `bringUp` falls back to a fire-and-forget `exec`.
   */
  startDetached?(cmd: string[], options?: { env?: Record<string, string> }): Promise<void>;
}

export interface RuntimeExecOptions {
  /** Kills the command, and anything it spawned, after this long. */
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface RuntimeExecResult {
  /** Exit status; `128 + signal` if the process was killed. */
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
