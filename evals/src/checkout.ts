import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Benchmark } from "./benchmark";
import { DATA_DIR, REPO_ROOT } from "./data";

export { REPO_ROOT };
const CACHE = join(REPO_ROOT, ".sandchest/benchmarks");

/**
 * A checkout of the benchmark at its pinned commit (or, with `"patched"`, at
 * the commit that fixed it). Remote benchmarks are fetched once (depth 1)
 * into a gitignored cache and reused. Local sources are relative to the eval
 * data directory.
 */
export async function checkout(benchmark: Benchmark, at: "vulnerable" | "patched" = "vulnerable"): Promise<string> {
  if ("path" in benchmark.source) return resolve(DATA_DIR, benchmark.source.path);
  const commit = at === "patched" ? benchmark.patched?.commit : benchmark.source.commit;
  if (!commit) throw new Error(`${benchmark.name} has no patched commit`);
  return checkoutAt(benchmark.source.repo, commit, at === "patched" ? `${benchmark.name}-patched` : benchmark.name);
}

/** A cached depth-1 checkout of `repo` at `commit`. */
export async function checkoutAt(repo: string, commit: string, name: string): Promise<string> {
  const dir = join(CACHE, `${name}-${commit.slice(0, 12)}`);
  if (existsSync(join(dir, ".git"))) return dir;

  await mkdir(CACHE, { recursive: true });
  const temp = await mkdtemp(join(CACHE, `.${name}-`));
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
