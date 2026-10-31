import { Sandbox } from "@vercel/sandbox";
import {
  WorkspaceError,
  type CloneOptions,
  type ExecOptions,
  type ExecResult,
  type RepoRef,
  type Workspace,
} from "./index";
import { BASE_ENV, cloneCommand, DEFAULT_CLONE_TIMEOUT_MS, resolveInside } from "./shared";

export interface SandboxWorkspaceOptions {
  /** Each vCPU comes with 2 GB of memory. Default 4. */
  vcpus?: number;
  /** The microVM stops itself after this long, even if `destroy()` is never called. Default 30 minutes. */
  timeoutMs?: number;
  /** Explicit access-token credentials. Omit to use the ambient OIDC token. */
  credentials?: { teamId: string; projectId: string; token: string };
  signal?: AbortSignal;
}

const SIGKILL_EXIT = 137;

/** A cloud microVM per scan. Non-persistent: nothing is snapshotted, and `destroy()` deletes it. */
export class SandboxWorkspace implements Workspace {
  readonly root: string;
  private destroying: Promise<void> | undefined;

  private constructor(private readonly sandbox: Sandbox) {
    this.root = `${sandbox.cwd}/repo`;
  }

  static async create(options: SandboxWorkspaceOptions = {}): Promise<SandboxWorkspace> {
    const sandbox = await Sandbox.create({
      resources: { vcpus: options.vcpus ?? 4 },
      timeout: options.timeoutMs ?? 30 * 60_000,
      persistent: false,
      signal: options.signal,
      ...options.credentials,
    });
    return new SandboxWorkspace(sandbox);
  }

  async clone(repo: RepoRef, options: CloneOptions): Promise<void> {
    const { cmd, env } = cloneCommand(this.root, repo, options);
    const result = await this.run(cmd, this.sandbox.cwd, { env, timeoutMs: options.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(result.timedOut ? "Clone timed out" : `Clone failed: ${result.stderr.trim()}`);
    }
  }

  exec(cmd: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return this.run(cmd, this.root, options);
  }

  async readFile(path: string): Promise<string> {
    this.assertUsable();
    // Symlinks can only reach files inside the microVM, which holds nothing but the checkout.
    const buffer = await this.sandbox.readFileToBuffer({ path: resolveInside(this.root, path) });
    if (!buffer) throw new WorkspaceError(`File not found: ${path}`);
    return buffer.toString("utf8");
  }

  destroy(): Promise<void> {
    this.destroying ??= this.sandbox.delete({ deleteOrphanSnapshots: true }).catch((error: unknown) => {
      // Allow a retry: a sandbox that failed to delete must not be forgotten.
      this.destroying = undefined;
      throw new WorkspaceError("Failed to delete sandbox", { cause: error });
    });
    return this.destroying;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.destroy();
  }

  private async run(cmd: string[], cwd: string, options: ExecOptions): Promise<ExecResult> {
    this.assertUsable();
    const [file, ...args] = cmd;
    if (!file) throw new WorkspaceError("Empty command");

    const started = performance.now();
    const finished = await this.sandbox.runCommand({
      cmd: file,
      args,
      cwd,
      env: { ...BASE_ENV, ...options.env },
      timeoutMs: options.timeoutMs,
    });
    const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()]);
    const durationMs = performance.now() - started;

    return {
      exitCode: finished.exitCode,
      stdout,
      stderr,
      // The sandbox enforces the timeout with SIGKILL and does not report it separately.
      timedOut: options.timeoutMs !== undefined && finished.exitCode === SIGKILL_EXIT && durationMs >= options.timeoutMs,
      durationMs,
    };
  }

  private assertUsable(): void {
    if (this.destroying) throw new WorkspaceError("Workspace has been destroyed");
  }
}
