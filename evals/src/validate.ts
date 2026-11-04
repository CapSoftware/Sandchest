/**
 * Checks every benchmark file parses, and that remote ones name commits and
 * cited lines that exist (fetching each once into the benchmark cache).
 *
 *   bun run validate [name|tag…] [--fetch]
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadBenchmarks, select, type Benchmark, type CodeRange } from "./benchmark";
import { checkout } from "./checkout";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { fetch: { type: "boolean", default: false } } });
const all = await loadBenchmarks();
const picked = positionals.length ? select(all, positionals) : all;
let problems = 0;

async function checkRanges(root: string, ranges: CodeRange[], what: string, name: string): Promise<void> {
  for (const range of ranges) {
    const file = join(root, range.file);
    if (!existsSync(file)) {
      console.log(`✗ ${name}: ${what} ${range.file} does not exist`);
      problems++;
      continue;
    }
    const lines = (await readFile(file, "utf8")).split("\n").length;
    if (range.endLine > lines || range.startLine > range.endLine) {
      console.log(`✗ ${name}: ${what} ${range.file}:${range.startLine}-${range.endLine} outside 1-${lines}`);
      problems++;
    }
  }
}

for (const benchmark of picked) {
  const ids = benchmark.expected.map((e) => e.id);
  if (new Set(ids).size !== ids.length) {
    console.log(`✗ ${benchmark.name}: duplicate expected ids`);
    problems++;
  }
  // Loose ranges inflate recall: findings that only pass through them still match.
  const ranges = benchmark.expected.flatMap((e) => e.locations.map((r) => ({ id: e.id, ...r })));
  for (const r of ranges) if (r.endLine - r.startLine > 25) console.log(`! ${benchmark.name}: ${r.id} ${r.file}:${r.startLine}-${r.endLine} spans ${r.endLine - r.startLine + 1} lines; cite the sink or missing check`);
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i]!;
      const b = ranges[j]!;
      if (a.id !== b.id && a.file === b.file && a.startLine <= b.endLine && b.startLine <= a.endLine) console.log(`! ${benchmark.name}: ${a.id} and ${b.id} overlap at ${a.file}:${Math.max(a.startLine, b.startLine)}`);
    }
  }
  if (benchmark.patched && "path" in benchmark.source) {
    console.log(`✗ ${benchmark.name}: patched needs a remote source`);
    problems++;
  }
  if (values.fetch || "path" in benchmark.source) {
    const root = await checkout(benchmark);
    for (const e of benchmark.expected) {
      await checkRanges(root, e.locations, `${e.id} location`, benchmark.name);
      if (e.replay) await checkRanges(root, [e.replay.entryPoint, ...e.replay.path].map((s) => ({ file: s.file, startLine: s.line, endLine: s.line })), `${e.id} replay`, benchmark.name);
    }
    if (benchmark.patched) {
      const patchedRoot = await checkout(benchmark, "patched");
      for (const e of benchmark.expected) await checkRanges(patchedRoot, e.patchedLocations ?? [], `${e.id} patched location`, benchmark.name);
    }
  }
  console.log(`✓ ${benchmark.name} (${benchmark.expected.length} expected, tags ${benchmark.tags.join(",")})`);
}
console.log(problems ? `\n${problems} problem(s)` : `\n${picked.length} benchmark(s) OK`);
process.exit(problems ? 1 : 0);
