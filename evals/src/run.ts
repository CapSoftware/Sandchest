/**
 * Runs deep scans against the benchmark set and scores them.
 *
 *   bun run evals [name…]              scan and score (all benchmarks by default)
 *   bun run evals --rescore <dir>      re-score saved scans, e.g. after judging findings
 *   bun run evals --private            scan the real-world targets in evals/private/targets.json
 *
 * Options: --parallel <n> benchmarks at once (default 1), --hunters <n>,
 * --hunter-turns <n>, --concurrency <n>, --no-osv.
 *
 * Results go to evals/results/<run>/ (or evals/private/results/<run>/), both
 * gitignored: scan reports contain code excerpts. Judge unmatched findings by
 * adding their fingerprints to evals/private/judgements/<benchmark>.json as
 * "real" or "false_positive"; judgements carry over to later runs.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createLlmClient, loadLlmConfig, startLocalIndexer } from "@sandchest/engine";
import { createOsvClient, loadPricing, runScan, type ScanLimits, type ScanReport } from "@sandchest/engine/scan";
import { z } from "zod";
import { loadBenchmarks, type Benchmark } from "./benchmark";
import { checkout, REPO_ROOT } from "./checkout";
import { aggregate, score, type BenchmarkScore, type Judgements } from "./score";

const EVALS = join(REPO_ROOT, "evals");
const PRIVATE = join(EVALS, "private");

/** Launch thresholds (SPEC §19). */
const THRESHOLDS = { recall: 0.7, precision: 0.8, medianMinutes: 15 };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rescore: { type: "string" },
    private: { type: "boolean", default: false },
    parallel: { type: "string", default: "1" },
    hunters: { type: "string" },
    "hunter-turns": { type: "string" },
    concurrency: { type: "string" },
    "no-osv": { type: "boolean", default: false },
  },
});

interface Outcome {
  benchmark: Benchmark;
  report?: ScanReport;
  error?: string;
}

// `bun run evals` runs from evals/; paths on the command line are relative to where it was typed.
const run = values.rescore ? await rescore(resolve(process.env.INIT_CWD ?? REPO_ROOT, values.rescore)) : await scanAll();
await summarise(run.outcomes, run.dir);

async function scanAll(): Promise<{ outcomes: Outcome[]; dir: string }> {
  const benchmarks = values.private ? await privateTargets() : await selectBenchmarks(positionals);
  const runDir = join(values.private ? join(PRIVATE, "results") : join(EVALS, "results"), new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(runDir, { recursive: true });
  console.error(`Scanning ${benchmarks.length} target(s) → ${runDir}\n`);

  const limits: Partial<ScanLimits> = {
    ...(values.hunters && { maxHunters: Number(values.hunters) }),
    ...(values["hunter-turns"] && { hunterTurns: Number(values["hunter-turns"]) }),
    ...(values.concurrency && { concurrency: Number(values.concurrency) }),
  };
  const client = createLlmClient(loadLlmConfig());
  const osv = values["no-osv"] ? undefined : createOsvClient();
  const pricing = loadPricing();

  const outcomes: Outcome[] = [];
  const queue = [...benchmarks];
  const worker = async () => {
    for (let benchmark = queue.shift(); benchmark; benchmark = queue.shift()) {
      const started = Date.now();
      const say = (message: string) => console.error(`[${benchmark!.name} ${((Date.now() - started) / 1000).toFixed(0)}s] ${message}`);
      try {
        const root = await checkout(benchmark);
        await using indexer = await startLocalIndexer(root);
        const report = await runScan({
          client,
          indexer: indexer.client,
          osv,
          pricing,
          limits,
          onEvent: (event) => {
            if (event.type === "stage" || event.type === "warning") say("message" in event ? event.message : "");
          },
        });
        await writeFile(join(runDir, `${benchmark.name}.scan.json`), `${JSON.stringify(report, null, 2)}\n`);
        outcomes.push({ benchmark, report });
      } catch (error) {
        say(`failed: ${(error as Error).message}`);
        outcomes.push({ benchmark, error: (error as Error).message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.parallel)) }, worker));
  return { outcomes, dir: runDir };
}

async function rescore(dir: string): Promise<{ outcomes: Outcome[]; dir: string }> {
  const benchmarks = new Map((await loadBenchmarks()).map((b) => [b.name, b]));
  const outcomes: Outcome[] = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".scan.json"))) {
    const name = file.replace(/\.scan\.json$/, "");
    const report = JSON.parse(await readFile(join(dir, file), "utf8")) as ScanReport;
    const benchmark = benchmarks.get(name) ?? { name, description: "", kind: "clean" as const, source: { path: "." }, expected: [], decoys: [] };
    outcomes.push({ benchmark, report });
  }
  return { outcomes, dir };
}

async function selectBenchmarks(names: string[]): Promise<Benchmark[]> {
  const all = await loadBenchmarks();
  if (names.length === 0) return all;
  const unknown = names.filter((name) => !all.some((b) => b.name === name));
  if (unknown.length > 0) throw new Error(`Unknown benchmark(s): ${unknown.join(", ")}. Available: ${all.map((b) => b.name).join(", ")}`);
  return all.filter((b) => names.includes(b.name));
}

const Targets = z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), path: z.string().min(1) }));

/** Real-world targets: local checkouts we own, scanned with no expected findings. */
async function privateTargets(): Promise<Benchmark[]> {
  const file = join(PRIVATE, "targets.json");
  if (!existsSync(file)) throw new Error(`No ${file}. Create it as [{ "name": "my-app", "path": "/path/to/checkout" }].`);
  const targets = Targets.parse(JSON.parse(await readFile(file, "utf8")));
  return targets.map(({ name, path }) => ({ name, description: "", kind: "clean", source: { path }, expected: [], decoys: [] }));
}

async function loadJudgements(name: string): Promise<Judgements> {
  const file = join(PRIVATE, "judgements", `${name}.json`);
  return existsSync(file) ? (JSON.parse(await readFile(file, "utf8")) as Judgements) : {};
}

async function summarise(outcomes: Outcome[], dir: string): Promise<void> {
  outcomes.sort((a, b) => a.benchmark.name.localeCompare(b.benchmark.name));
  const scores: BenchmarkScore[] = [];
  const rows: string[][] = [["benchmark", "LOC", "time", "shown", "recall", "precision", "unjudged", "tokens in/out", "cost"]];

  for (const { benchmark, report, error } of outcomes) {
    if (!report) {
      rows.push([benchmark.name, "", "", "", `error: ${error}`, "", "", "", ""]);
      continue;
    }
    const s = score(benchmark, report, await loadJudgements(benchmark.name));
    scores.push(s);
    rows.push([
      benchmark.name,
      report.repo.loc.toLocaleString("en"),
      `${(report.durationMs / 60_000).toFixed(1)}m`,
      String(s.shown.total),
      s.recall === null ? "—" : `${pct(s.recall)} (${s.found.serious}/${s.expected.serious})`,
      precision(s.precision),
      String(s.shown.unjudged),
      `${kilo(report.usage.total.inputTokens)}/${kilo(report.usage.total.outputTokens)}`,
      report.usage.costUsd === undefined ? "—" : `$${report.usage.costUsd.toFixed(2)}`,
    ]);
  }

  const total = aggregate(scores);
  const durations = outcomes.flatMap((o) => (o.report ? [o.report.durationMs / 60_000] : [])).sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor((durations.length - 1) / 2)]! : null;
  console.log(`\n${table(rows)}\n`);
  console.log(`Recall (critical+high, pooled): ${total.recall === null ? "—" : pct(total.recall)}  ${mark(total.recall, (r) => r >= THRESHOLDS.recall)} target ≥ ${pct(THRESHOLDS.recall)}`);
  console.log(`Precision (shown findings):     ${precision(total.precision)}  ${mark(total.precision.lower, (p) => p >= THRESHOLDS.precision)} target ≥ ${pct(THRESHOLDS.precision)}${total.unjudged ? ` (${total.unjudged} unjudged)` : ""}`);
  console.log(`Median scan time:               ${median === null ? "—" : `${median.toFixed(1)}m`}  ${mark(median, (m) => m < THRESHOLDS.medianMinutes)} target < ${THRESHOLDS.medianMinutes}m`);

  for (const s of scores.filter((s) => s.missed.length > 0)) {
    console.log(`\n${s.name} missed: ${s.missed.map((m) => `${m.id} (${m.severity})`).join(", ")}`);
  }
  const unjudged = scores.flatMap((s) => s.findings.filter((f) => f.verdict === "unjudged").map((f) => ({ benchmark: s.name, ...f })));
  if (unjudged.length > 0) {
    const lines = unjudged.map((f) => `- [${f.benchmark}] ${f.fingerprint} ${f.severity}/${f.confidence} ${f.title} (${f.at})`);
    await writeFile(join(dir, "unjudged.md"), `# Unjudged findings\n\nAdd each fingerprint to evals/private/judgements/<benchmark>.json as "real" or "false_positive".\n\n${lines.join("\n")}\n`);
    console.log(`\n${unjudged.length} unmatched findings to judge: ${join(dir, "unjudged.md")}`);
  }
  await writeFile(join(dir, "summary.json"), `${JSON.stringify({ aggregate: total, medianMinutes: median, scores }, null, 2)}\n`);
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => (row[i] ?? "").length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function precision(p: { lower: number | null; known: number | null }): string {
  if (p.lower === null) return "—";
  return p.known === null || p.known === p.lower ? pct(p.lower) : `${pct(p.lower)}–${pct(p.known)}`;
}

function kilo(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
}

/** ✓ or ✗ against a target, or nothing when there is nothing to measure. */
function mark(value: number | null, meets: (value: number) => boolean): string {
  return value === null ? " " : meets(value) ? "✓" : "✗";
}
