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

/** A cached depth-1 checkout of `repo` at `commit`. A token, if given, is sent as a header and never written to disk. */
export async function checkoutAt(repo: string, commit: string, name: string, token?: string): Promise<string> {
  const dir = join(CACHE, `${name}-${commit.slice(0, 12)}`);
  if (existsSync(join(dir, ".git"))) return dir;

  await mkdir(CACHE, { recursive: true });
  const temp = await mkdtemp(join(CACHE, `.${name}-`));
  try {
    await git(temp, ["init", "--quiet"]);
    await git(temp, ["fetch", "--quiet", "--depth=1", repo, commit], token);
    await git(temp, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    // Atomic: a half-finished fetch never looks like a cached checkout.
    await rename(temp, dir);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    // Two jobs fetched the same checkout at once (fpcheck's pairs, parallel runs): the other one won.
    if (existsSync(join(dir, ".git"))) return dir;
    throw error;
  }
  return dir;
}

async function git(cwd: string, args: string[], token?: string): Promise<void> {
  // A token goes in a per-process header, so it is never in argv, the URL or FETCH_HEAD.
  const auth = token
    ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` }
    : {};
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...auth } });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
}
