import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceError,
  type CloneOptions,
  type ExecOptions,
  type ExecResult,
  type RepoRef,
  type Workspace,
} from "./index";
import { BASE_ENV, cloneCommand, DEFAULT_CLONE_TIMEOUT_MS, isInside, resolveInside } from "./shared";

/** Largest file `readFile` will load. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Output kept per stream; the rest is drained and discarded. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * A temporary directory and subprocesses on the host. Used for self-hosting,
 * evals and development.
 *
 * Commands run with a minimal environment (no host secrets, no user dotfiles)
 * in their own process group, so timeouts and `destroy()` kill everything a
 * command spawned.
 */
export class LocalWorkspace implements Workspace {
  readonly root: string;
  private readonly env: Record<string, string>;
  private readonly running = new Set<ChildProcess>();
  private destroyed = false;

  private constructor(private readonly dir: string) {
    this.root = join(dir, "repo");
    this.env = { ...BASE_ENV, PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, TMPDIR: dir };
  }

  static async create(options: { parentDir?: string } = {}): Promise<LocalWorkspace> {
    // realpath: on some systems the temp dir is behind a symlink, which would defeat containment checks.
    const dir = await realpath(await mkdtemp(join(options.parentDir ?? tmpdir(), "sandchest-")));
    const workspace = new LocalWorkspace(dir);
    await mkdir(workspace.root);
    return workspace;
  }

  async clone(repo: RepoRef, options: CloneOptions): Promise<void> {
    const { cmd, env } = cloneCommand(this.root, repo, options);
    const result = await this.run(cmd, this.dir, { env, timeoutMs: options.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new WorkspaceError(result.timedOut ? "Clone timed out" : `Clone failed: ${result.stderr.trim()}`);
    }
  }

  exec(cmd: string[], options: ExecOptions = {}): Promise<ExecResult> {
    return this.run(cmd, this.root, options);
  }

  async readFile(path: string): Promise<string> {
    this.assertUsable();
    // Resolve symlinks too: a hostile repo can link to files elsewhere on the host.
    const real = await realpath(resolveInside(this.root, path));
    if (!isInside(this.root, real)) throw new WorkspaceError(`Path escapes the checkout: ${path}`);

    const { size } = await stat(real);
    if (size > MAX_FILE_BYTES) throw new WorkspaceError(`File too large to read (${size} bytes): ${path}`);
    return readFile(real, "utf8");
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    for (const child of this.running) killGroup(child);
    await rm(this.dir, { recursive: true, force: true, maxRetries: 3 });
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.destroy();
  }

  private async run(cmd: string[], cwd: string, options: ExecOptions): Promise<ExecResult> {
    this.assertUsable();
    const [file, ...args] = cmd;
    if (!file) throw new WorkspaceError("Empty command");

    const started = performance.now();
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        cwd,
        env: { ...this.env, ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      this.running.add(child);

      const stdout = collect(child.stdout!);
      const stderr = collect(child.stderr!);
      let timedOut = false;
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              killGroup(child);
            }, options.timeoutMs);

      const settle = () => {
        clearTimeout(timer);
        this.running.delete(child);
      };
      child.once("error", (error) => {
        settle();
        reject(new WorkspaceError(`Could not run ${file}: ${error.message}`, { cause: error }));
      });
      child.once("close", (code, signal) => {
        settle();
        resolve({
          exitCode: code ?? 128 + (signal ? constants.signals[signal] : 0),
          stdout: stdout(),
          stderr: stderr(),
          timedOut,
          durationMs: performance.now() - started,
        });
      });
    });
  }

  private assertUsable(): void {
    if (this.destroyed) throw new WorkspaceError("Workspace has been destroyed");
  }
}

/** Kills the process and every descendant in its group. */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Buffers a stream up to MAX_OUTPUT_BYTES and returns a reader for the decoded text. */
function collect(stream: NodeJS.ReadableStream): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  stream.on("data", (chunk: Buffer) => {
    if (size >= MAX_OUTPUT_BYTES) return;
    chunks.push(chunk.subarray(0, MAX_OUTPUT_BYTES - size));
    size += chunk.length;
  });
  return () => Buffer.concat(chunks).toString("utf8");
}
