import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ATTACKERS, CATEGORIES, SEVERITIES } from "@sandchest/engine/scan";
import { z } from "zod";
import { DATA_DIR, requireData } from "./data";

const Range = z.object({
  file: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

const Step = z.object({ file: z.string().min(1), line: z.number().int().positive(), note: z.string().min(3) });

/**
 * A hunter-shaped report of the expected bug, for replaying through the
 * skeptic without a full scan (`bun run fpcheck`). Lines are at the
 * vulnerable commit.
 */
const Replay = z.object({
  title: z.string().min(8).max(140),
  entryPoint: z.object({ file: z.string().min(1), line: z.number().int().positive(), description: z.string().min(3) }),
  path: z.array(Step).min(1).max(12),
  attacker: z.enum(ATTACKERS),
  trigger: z.string().min(10),
  proofOfConcept: z.string().min(20),
  impact: z.string().min(10),
});

const Expected = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  cwe: z.array(z.string().regex(/^CWE-\d+$/)),
  locations: z.array(Range).min(1).max(3),
  /** Where the same code sits at the patched commit; a finding there after the fix is a false positive. */
  patchedLocations: z.array(Range).max(3).optional(),
  /** The fix only covers some paths, so the bug is still (partly) there when patched: don't count a re-flag as a false positive. */
  partialFix: z.boolean().optional(),
  replay: Replay.optional(),
});

const Decoy = Range.extend({ note: z.string() });

export const BenchmarkSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  kind: z.enum(["vulnerable", "clean"]),
  source: z.union([
    z.object({ repo: z.url(), commit: z.string().regex(/^[0-9a-f]{40}$/) }),
    /** Relative to the eval data directory. */
    z.object({ path: z.string().min(1) }),
  ]),
  /** The commit that fixed the expected bugs, for real-world advisories: scanning it measures false positives on fixed code. */
  patched: z.object({ commit: z.string().regex(/^[0-9a-f]{40}$/) }).optional(),
  /** Public advisory ids (GHSA-…, CVE-…) the expected bugs come from. */
  advisories: z.array(z.string()).default([]),
  /**
   * Which run sets include it. `core` runs on every change; `cve` are real
   * advisories in real apps; `large` are repositories over 200k LOC.
   */
  tags: z.array(z.string().regex(/^[a-z0-9-]+$/)).default(["core"]),
  expected: z.array(Expected),
  decoys: z.array(Decoy).default([]),
});

export type Benchmark = z.infer<typeof BenchmarkSchema>;
export type ExpectedFinding = z.infer<typeof Expected>;
export type CodeRange = z.infer<typeof Range>;
export type ReplayCandidate = z.infer<typeof Replay>;

export const BENCHMARK_DIR = join(DATA_DIR, "benchmarks");

export async function loadBenchmarks(dir = BENCHMARK_DIR): Promise<Benchmark[]> {
  if (dir === BENCHMARK_DIR) requireData();
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(
    files.map(async (file) => {
      const parsed = BenchmarkSchema.safeParse(JSON.parse(await readFile(join(dir, file), "utf8")));
      if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
      if (`${parsed.data.name}.json` !== file) throw new Error(`${file}: name must match the file name`);
      return parsed.data;
    }),
  );
}

/** Benchmarks selected by name or tag; every benchmark tagged `core` when none are given. */
export function select(all: Benchmark[], picks: string[]): Benchmark[] {
  if (picks.length === 0) return all.filter((b) => b.tags.includes("core"));
  if (picks.includes("all")) return all;
  const unknown = picks.filter((pick) => !all.some((b) => b.name === pick || b.tags.includes(pick)));
  if (unknown.length > 0) {
    const tags = [...new Set(all.flatMap((b) => b.tags))].sort();
    throw new Error(`Unknown benchmark or tag: ${unknown.join(", ")}. Benchmarks: ${all.map((b) => b.name).join(", ")}. Tags: ${tags.join(", ")}, all.`);
  }
  return all.filter((b) => picks.includes(b.name) || b.tags.some((tag) => picks.includes(tag)));
}
