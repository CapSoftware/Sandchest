import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Benchmark } from "./benchmark";

export const REPO_ROOT = resolve(import.meta.dir, "../..");
const CACHE = join(REPO_ROOT, ".sandchest/benchmarks");

/**
 * A checkout of the benchmark at its pinned commit. Remote benchmarks are
 * fetched once (depth 1) into a gitignored cache and reused.
 */
export async function checkout(benchmark: Benchmark): Promise<string> {
  if ("path" in benchmark.source) return resolve(REPO_ROOT, benchmark.source.path);

  const { repo, commit } = benchmark.source;
  const dir = join(CACHE, `${benchmark.name}-${commit.slice(0, 12)}`);
  if (existsSync(join(dir, ".git"))) return dir;

  await mkdir(CACHE, { recursive: true });
  const temp = await mkdtemp(join(CACHE, `.${benchmark.name}-`));
  try {
    await git(temp, "init", "--quiet");
    await git(temp, "fetch", "--quiet", "--depth=1", repo, commit);
    await git(temp, "checkout", "--quiet", "--detach", "FETCH_HEAD");
    // Atomic: a half-finished fetch never looks like a cached checkout.
    await rename(temp, dir);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
}
