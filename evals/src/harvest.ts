/**
 * Turns real use into ground truth. Every finding a fix check saw fixed is a
 * real bug with a known fix: we check out the commit it was found at and the
 * commit it was fixed at, and write a pairs file `fpcheck` replays — recall on
 * the vulnerable version, false positives on the patched one. Run before any
 * prompt or model change ships, so changes are judged on real bugs.
 *
 *   bun run harvest [--include-private] [--out evals/private/fixpairs-harvested.json]
 *
 * Public repositories only by default: harvesting a private repository means
 * running our evals on a customer's code, which needs their consent.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createDb, fixedPairs } from "@sandchest/db";
import { REPO_ROOT } from "./checkout";

const { values } = parseArgs({
  options: { "include-private": { type: "boolean", default: false }, out: { type: "string", default: "evals/private/fixpairs-harvested.json" } },
});

const CACHE = join(REPO_ROOT, ".sandchest/harvest");
const database = createDb(process.env.DATABASE_URL!, { max: 1 });
const pairs = await fixedPairs(database, { includePrivate: values["include-private"] });
await database.$client.end();
console.log(`${pairs.length} fixed findings with a known fix commit${values["include-private"] ? "" : " (public repositories only)"}.`);

/** A checkout of `repo` at `sha`, cached. Private repos need a token in GITHUB_TOKEN. */
async function checkoutAt(repo: string, sha: string): Promise<string> {
  const dir = join(CACHE, `${repo.replace("/", "__")}-${sha.slice(0, 12)}`);
  if (existsSync(join(dir, ".git"))) return dir;
  await mkdir(CACHE, { recursive: true });
  const temp = await mkdtemp(join(CACHE, ".tmp-"));
  const token = process.env.GITHUB_TOKEN;
  const url = token ? `https://x-access-token:${token}@github.com/${repo}.git` : `https://github.com/${repo}.git`;
  try {
    for (const args of [["init", "--quiet"], ["fetch", "--quiet", "--depth=1", url, sha], ["checkout", "--quiet", "--detach", "FETCH_HEAD"]]) {
      const proc = Bun.spawn(["git", ...args], { cwd: temp, stdout: "ignore", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      if ((await proc.exited) !== 0) throw new Error(`git ${args[0]}: ${(await new Response(proc.stderr).text()).trim().replace(token ?? "\u0000", "***")}`);
    }
    await rename(temp, dir);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
  return dir;
}

const out: unknown[] = [];
for (const pair of pairs) {
  try {
    const [vulnerableDir, patchedDir] = await Promise.all([checkoutAt(pair.repo, pair.vulnerableSha), checkoutAt(pair.repo, pair.patchedSha)]);
    out.push({
      name: `${pair.repo.split("/")[1]}-${pair.findingId.slice(0, 8)}`,
      vulnerableDir,
      patchedDir,
      candidate: pair.candidate,
      threatModel: pair.threatModel ?? {
        summary: "Unknown application.",
        stack: [],
        entryPoints: [],
        authModel: "Unknown.",
        trustBoundaries: [],
        sensitiveAssets: [],
        dangerousSinks: [],
        frameworkProtections: [],
        abuseSurfaces: [],
        subsystems: [],
      },
    });
    console.log(`  ✓ ${pair.candidate.title.slice(0, 80)}`);
  } catch (error) {
    console.log(`  ✗ skipped (${(error as Error).message.slice(0, 120)})`);
  }
}
const file = resolve(REPO_ROOT, values.out);
await writeFile(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nWrote ${out.length} pairs to ${values.out}. Replay with: bun run fpcheck ${file}`);
