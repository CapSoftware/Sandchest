/**
 * Known bugs with a known fix: the vulnerable and the patched checkout of the
 * same code, and the bug in hunter shape. From benchmarks with a `patched`
 * commit and a `replay` on an expected bug (regenerable from public commits),
 * plus any pair files in the data's fixpairs/ (e.g. from `bun run harvest`).
 * Shared by fpcheck (does the skeptic re-flag fixed code?) and fixeval (does
 * the fix check close it?).
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Candidate, ThreatModel } from "@sandchest/engine/scan";
import { loadBenchmarks, select } from "./benchmark";
import { checkout } from "./checkout";
import { FIXPAIRS_DIR } from "./data";

export interface Pair {
  name: string;
  vulnerableDir: string;
  patchedDir: string;
  candidate: Candidate;
  threatModel: ThreatModel;
  partialFix?: boolean;
  /** Where the fix is public: the repository and the two commits, for the fix's diff. */
  github?: { repo: string; base: string; head: string };
}

/** Enough context for the skeptic when no recon ran: it reads the code itself. */
export const UNKNOWN_APP: ThreatModel = {
  summary: "A web application under review.",
  stack: [],
  entryPoints: [],
  authModel: "Unknown: read the code.",
  trustBoundaries: [],
  sensitiveAssets: [],
  dangerousSinks: [],
  frameworkProtections: [],
  abuseSurfaces: [],
  subsystems: [],
} as unknown as ThreatModel;

/** Pairs for the named benchmarks or tags (all when none), plus pair files unless benchmarks are named. */
export async function loadPairs(picks: string[] = [], pairsFile?: string): Promise<Pair[]> {
  const pairs: Pair[] = [];
  const benchmarks = (await loadBenchmarks()).filter((b) => b.patched && b.expected.some((e) => e.replay));
  for (const benchmark of picks.length ? select(benchmarks, picks) : benchmarks) {
    const [vulnerableDir, patchedDir] = await Promise.all([checkout(benchmark), checkout(benchmark, "patched")]);
    for (const expected of benchmark.expected.filter((e) => e.replay)) {
      const r = expected.replay!;
      pairs.push({
        name: `${benchmark.name}/${expected.id}`,
        vulnerableDir,
        patchedDir,
        partialFix: expected.partialFix,
        threatModel: UNKNOWN_APP,
        ...("repo" in benchmark.source && { github: { repo: benchmark.source.repo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""), base: benchmark.source.commit, head: benchmark.patched!.commit } }),
        candidate: {
          title: r.title,
          category: expected.category,
          severity: expected.severity,
          entryPoint: r.entryPoint,
          path: r.path,
          preconditions: { attacker: r.attacker, trigger: r.trigger, details: "none" },
          proofOfConcept: r.proofOfConcept,
          impact: r.impact,
        },
      });
    }
  }
  const files = pairsFile ? [pairsFile] : existsSync(FIXPAIRS_DIR) && !picks.length ? (await readdir(FIXPAIRS_DIR)).filter((f) => f.endsWith(".json")).map((f) => join(FIXPAIRS_DIR, f)) : [];
  for (const file of files) {
    const list = JSON.parse(await readFile(file, "utf8")) as Array<Partial<Pair>>;
    for (const pair of list) {
      if (!pair.vulnerableDir || !pair.candidate) continue;
      if (!existsSync(pair.vulnerableDir) || !existsSync(pair.patchedDir!)) {
        console.error(`skip ${pair.name}: checkout missing (${pair.vulnerableDir}); regenerate it with \`bun run harvest\``);
        continue;
      }
      pairs.push({ threatModel: UNKNOWN_APP, ...pair } as Pair);
    }
  }
  return pairs;
}
