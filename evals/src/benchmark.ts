import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CATEGORIES, SEVERITIES } from "@sandchest/engine/scan";
import { z } from "zod";

const Range = z.object({
  file: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

const Expected = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  cwe: z.array(z.string().regex(/^CWE-\d+$/)),
  locations: z.array(Range).min(1).max(3),
});

const Decoy = Range.extend({ note: z.string() });

export const BenchmarkSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  kind: z.enum(["vulnerable", "clean"]),
  source: z.union([
    z.object({ repo: z.url(), commit: z.string().regex(/^[0-9a-f]{40}$/) }),
    z.object({ path: z.string().min(1) }),
  ]),
  expected: z.array(Expected),
  decoys: z.array(Decoy).default([]),
});

export type Benchmark = z.infer<typeof BenchmarkSchema>;
export type ExpectedFinding = z.infer<typeof Expected>;
export type CodeRange = z.infer<typeof Range>;

export const BENCHMARK_DIR = join(import.meta.dir, "../benchmarks");

export async function loadBenchmarks(dir = BENCHMARK_DIR): Promise<Benchmark[]> {
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
