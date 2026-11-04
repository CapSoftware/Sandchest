/**
 * False-positive check on fixed code: replay a known bug through the skeptic
 * against the VULNERABLE and the PATCHED version of the same code. Confirming
 * it on the vulnerable version is recall on a real bug; confirming it on the
 * patched version, where the fix is, is a *confirmed false positive*: the
 * skeptic missed the guard, the failure mode behind our real-world false
 * positives. The fix is the ground truth, so no human judgement is needed.
 * Cents per pair, so run it on every skeptic or prompt change.
 *
 *   bun run fpcheck [name|tag…] [--repeat N] [--ground] [--pairs <file.json>]
 *
 * Pairs come from benchmarks with a `patched` commit and a `replay` on an
 * expected bug (regenerable from public commits), plus any pair files in the
 * data's fixpairs/ ({ name, vulnerableDir, patchedDir, candidate, threatModel },
 * e.g. from `bun run harvest`). Partial fixes are reported but kept out of
 * the false-positive rate.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createLlmClient, loadLlmConfig, startLocalIndexer } from "@sandchest/engine";
import { loadPricing, verifyFindings, type Candidate, type ThreatModel } from "@sandchest/engine/scan";
import { loadBenchmarks, select } from "./benchmark";
import { checkout } from "./checkout";
import { FIXPAIRS_DIR, requireData } from "./data";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { repeat: { type: "string", default: "3" }, ground: { type: "boolean", default: false }, pairs: { type: "string" } },
});

interface Pair {
  name: string;
  vulnerableDir: string;
  patchedDir: string;
  candidate: Candidate;
  threatModel: ThreatModel;
  partialFix?: boolean;
}

/** Enough context for the skeptic when no recon ran: it reads the code itself. */
const UNKNOWN_APP: ThreatModel = {
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

requireData();
const pairs: Pair[] = [];
const benchmarks = (await loadBenchmarks()).filter((b) => b.patched && b.expected.some((e) => e.replay));
for (const benchmark of positionals.length ? select(benchmarks, positionals) : benchmarks) {
  const [vulnerableDir, patchedDir] = await Promise.all([checkout(benchmark), checkout(benchmark, "patched")]);
  for (const expected of benchmark.expected.filter((e) => e.replay)) {
    const r = expected.replay!;
    pairs.push({
      name: `${benchmark.name}/${expected.id}`,
      vulnerableDir,
      patchedDir,
      partialFix: expected.partialFix,
      threatModel: UNKNOWN_APP,
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
const files = values.pairs ? [values.pairs] : existsSync(FIXPAIRS_DIR) && !positionals.length ? (await readdir(FIXPAIRS_DIR)).filter((f) => f.endsWith(".json")).map((f) => join(FIXPAIRS_DIR, f)) : [];
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
if (pairs.length === 0) {
  console.error("No pairs: add `patched` + `replay` to a benchmark, or a pairs file to fixpairs/.");
  process.exit(2);
}

const repeat = Math.max(1, Math.floor(Number(values.repeat)) || 1);
const client = createLlmClient(loadLlmConfig());
const pricing = loadPricing();
let cost = 0;

/** The fraction of `repeat` runs in which the skeptic confirms the finding (shown, not low) on `dir`. */
async function confirmRate(dir: string, pair: Pair): Promise<number> {
  await using indexer = await startLocalIndexer(dir);
  await indexer.client.ready();
  let confirmed = 0;
  for (let run = 0; run < repeat; run++) {
    const { results, costUsd } = await verifyFindings({
      client,
      indexer: indexer.client,
      threatModel: pair.threatModel,
      findings: [pair.candidate],
      pricing,
      investigateAuth: values.ground,
    });
    cost += costUsd ?? 0;
    const review = results[0]?.review;
    if (review && review.verdict.verdict === "confirmed" && review.verdict.confidence !== "low") confirmed++;
  }
  return confirmed / repeat;
}

const pct = (x: number) => `${Math.round(100 * x)}%`;
const width = Math.max(28, ...pairs.map((p) => p.name.length + 2));
console.log(`${"pair".padEnd(width)} vuln→confirmed  fixed→confirmed (=FP)`);
const rows = await Promise.all(
  pairs.map(async (pair) => {
    const [vuln, patched] = await Promise.all([confirmRate(pair.vulnerableDir, pair), confirmRate(pair.patchedDir, pair)]);
    console.log(`${pair.name.padEnd(width)} ${pct(vuln).padStart(6)}          ${pct(patched).padStart(6)}${pair.partialFix ? "  (partial fix: not counted)" : ""}`);
    return { pair, vuln, patched };
  }),
);
const clean = rows.filter((r) => !r.pair.partialFix);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(`\nPairs: ${pairs.length} (${clean.length} clean fixes), repeat ${repeat}${values.ground ? " (auth-grounded)" : ""}`);
console.log(`Recall on the real bug (confirmed on vulnerable): ${pct(mean(rows.map((r) => r.vuln)))}  (want high)`);
console.log(`False positives (confirmed on fixed code):        ${pct(mean(clean.map((r) => r.patched)))}  (want 0: re-flagging a fixed bug)`);
console.log(`Cost: $${cost.toFixed(2)}`);
