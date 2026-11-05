import { Sandbox } from "@vercel/sandbox";
import { readFile } from "node:fs/promises";
import {
  WorkspaceError,
  type CloneOptions,
  type ExecOptions,
  type ExecResult,
  type IndexerBinary,
  type RepoRef,
  type Workspace,
} from "./index";
import { INDEXER_PORT, type IndexerHandle } from "./indexer";
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

// Arguments are positional, never interpolated into the script.
const DOWNLOAD_SCRIPT = `set -e
mkdir -p "$(dirname "$2")"
curl -fsSL --retry 6 --retry-max-time 90 --max-time 60 "$1" -o "$2"
echo "$3  $2" | sha256sum -c - >/dev/null
chmod 755 "$2"`;

/** Polls `/health` until the daemon answers. */
async function waitForHealth(url: string, token: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new WorkspaceError(`Indexer did not become ready: ${last}`);
}

/** A cloud microVM per scan. Non-persistent: nothing is snapshotted, and `destroy()` deletes it. */
export class SandboxWorkspace implements Workspace {
  readonly root: string;
  private destroying: Promise<void> | undefined;
  private installing: Promise<string> | undefined;

  private constructor(private readonly sandbox: Sandbox) {
    this.root = `${sandbox.cwd}/repo`;
  }

  static async create(options: SandboxWorkspaceOptions = {}): Promise<SandboxWorkspace> {
    const sandbox = await Sandbox.create({
      resources: { vcpus: options.vcpus ?? 4 },
      ports: [INDEXER_PORT],
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

  async startDetached(cmd: string[], options: { env?: Record<string, string> } = {}): Promise<void> {
    this.assertUsable();
    const [file, ...args] = cmd;
    if (!file) throw new WorkspaceError("Empty command");
    // Detached, like the indexer: the process keeps running on the microVM
    // until the VM stops, and `destroy()` deletes the VM. Same cwd and base
    // environment as `exec`, so `npm run start` finds the checkout's package.json.
    await this.sandbox.runCommand({ cmd: file, args, cwd: this.root, env: { ...BASE_ENV, ...options.env }, detached: true });
  }

  async readFile(path: string): Promise<string> {
    this.assertUsable();
    // Symlinks can only reach files inside the microVM, which holds nothing but the checkout.
    const buffer = await this.sandbox.readFileToBuffer({ path: resolveInside(this.root, path) });
    if (!buffer) throw new WorkspaceError(`File not found: ${path}`);
    return buffer.toString("utf8");
  }

  /**
   * Puts the indexer in the microVM, runs it detached on the exposed port
   * with a random token, and waits until it answers over HTTPS.
   */
  installIndexer(binary: IndexerBinary): Promise<void> {
    return this.install(binary).then(() => undefined);
  }

  async startIndexer(binary: IndexerBinary, options: { readyTimeoutMs?: number } = {}): Promise<IndexerHandle> {
    const path = await this.install(binary);
    this.assertUsable();
    const token = crypto.randomUUID();
    await this.sandbox.runCommand({
      cmd: path,
      args: ["serve", this.root, "--host", "0.0.0.0", "--port", String(INDEXER_PORT)],
      env: { SANDCHEST_INDEX_TOKEN: token },
      detached: true,
    });
    const url = this.sandbox.domain(INDEXER_PORT);
    await waitForHealth(url, token, options.readyTimeoutMs ?? 30_000);
    return { url, token };
  }

  private install(binary: IndexerBinary): Promise<string> {
    this.assertUsable();
    this.installing ??= (async () => {
      const path = `${this.sandbox.cwd}/bin/sandchest-index`;
      if ("path" in binary) {
        await this.sandbox.writeFiles([{ path, content: await readFile(binary.path), mode: 0o755 }]);
      } else {
        // Downloaded inside the VM (fast, in-region) and verified before it runs.
        const result = await this.run(["sh", "-c", DOWNLOAD_SCRIPT, "download", binary.url, path, binary.sha256], this.sandbox.cwd, { timeoutMs: 180_000 });
        if (result.exitCode !== 0) throw new WorkspaceError(`Indexer download failed: ${result.stderr.trim()}`);
      }
      return path;
    })();
    return this.installing;
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
