/**
 * Runs deep scans against the benchmark set, scores them, records the run in
 * history and prints the scorecard against the last comparable run.
 *
 *   bun run evals [name|tag…]          scan and score (`core` benchmarks by default; `all`, `cve`, `large`, …)
 *   bun run evals --repeat 3           three scans per benchmark: stability, and less noise in every number
 *   bun run evals --rescore <run>      re-score saved scans, e.g. after judging findings
 *   bun run evals --private            scan the real-world targets in the data's targets.json
 *
 * Options: --parallel <n> scans at once (default 1), --no-patched (skip
 * scanning fixed commits), --note "<what changed>", --baseline <run>|none,
 * --hunters <n>, --hunter-turns <n>, --concurrency <n>, --no-osv.
 *
 * Runs are written to runs/<id>/ in the private eval data repository. Judge
 * unmatched findings with `bun run judge <run>`; judgements carry over.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createClassifier, createLlmClient, loadClassifierConfig, loadLlmConfig, startLocalIndexer } from "@sandchest/engine";
import { createOsvClient, loadPricing, runScan, type ScanLimits, type ScanReport } from "@sandchest/engine/scan";
import { z } from "zod";
import { loadBenchmarks, select, type Benchmark } from "./benchmark";
import { checkout } from "./checkout";
import { DATA_DIR, REPO_ROOT, requireData, RUNS_DIR } from "./data";
import { readRun, scoreRun, type RunMeta } from "./runs";
import { appendHistory, readHistory, runDir, scorecard } from "./scorecard";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rescore: { type: "string" },
    private: { type: "boolean", default: false },
    parallel: { type: "string", default: "1" },
    repeat: { type: "string", default: "1" },
    "no-patched": { type: "boolean", default: false },
    note: { type: "string" },
    baseline: { type: "string" },
    hunters: { type: "string" },
    "hunter-turns": { type: "string" },
    concurrency: { type: "string" },
    "no-osv": { type: "boolean", default: false },
  },
});

interface Job {
  benchmark: Benchmark;
  at: "vulnerable" | "patched";
  repeat: number;
  file: string;
}

requireData();

async function scanAll(): Promise<string> {
  const benchmarks = values.private ? await privateTargets() : select(await loadBenchmarks(), positionals);
  const repeat = Math.max(1, Math.floor(Number(values.repeat)) || 1);
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(RUNS_DIR, id);
  await mkdir(dir, { recursive: true });

  const limits: Partial<ScanLimits> = {
    ...(values.hunters && { maxHunters: Number(values.hunters) }),
    ...(values["hunter-turns"] && { hunterTurns: Number(values["hunter-turns"]) }),
    ...(values.concurrency && { concurrency: Number(values.concurrency) }),
  };
  const meta: RunMeta = {
    id,
    startedAt: new Date().toISOString(),
    ...(await engineCommit()),
    config: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^LLM_(MODEL|TEMPERATURE|SEED)|^LLM_CLASSIFIER_MODEL$/.test(k))),
      ...limits,
      osv: !values["no-osv"],
    } as RunMeta["config"],
    benchmarks: benchmarks.map((b) => b.name),
    repeat,
    ...(values.note && { note: values.note }),
  };
  await writeFile(join(dir, "run.json"), `${JSON.stringify(meta, null, 2)}\n`);

  const jobs: Job[] = [];
  for (let r = 1; r <= repeat; r++) {
    for (const benchmark of benchmarks) jobs.push({ benchmark, at: "vulnerable", repeat: r, file: `${benchmark.name}${r > 1 ? `.r${r}` : ""}.scan.json` });
  }
  if (!values["no-patched"]) {
    for (const benchmark of benchmarks.filter((b) => b.patched)) jobs.push({ benchmark, at: "patched", repeat: 1, file: `${benchmark.name}.patched.scan.json` });
  }
  console.error(`${jobs.length} scan(s) of ${benchmarks.length} benchmark(s) → ${dir}\n`);

  const client = createLlmClient(loadLlmConfig());
  const classifierConfig = loadClassifierConfig();
  const classifier = classifierConfig ? createClassifier(classifierConfig) : undefined;
  const osv = values["no-osv"] ? undefined : createOsvClient();
  const pricing = loadPricing();

  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const started = Date.now();
      const label = `${job.benchmark.name}${job.repeat > 1 ? ` r${job.repeat}` : ""}${job.at === "patched" ? " (fixed)" : ""}`;
      const say = (message: string) => console.error(`[${label} ${((Date.now() - started) / 1000).toFixed(0)}s] ${message}`);
      try {
        const root = await checkout(job.benchmark, job.at);
        await using indexer = await startLocalIndexer(root);
        const report: ScanReport = await runScan({
          client,
          classifier,
          indexer: indexer.client,
          osv,
          pricing,
          limits,
          onEvent: (event) => {
            if (event.type === "stage" || event.type === "warning") say("message" in event ? event.message : "");
          },
        });
        await writeFile(join(dir, job.file), `${JSON.stringify(report, null, 2)}\n`);
      } catch (error) {
        say(`failed: ${(error as Error).message}`);
        await writeFile(join(dir, job.file.replace(/\.scan\.json$/, ".error.txt")), `${(error as Error).stack ?? error}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Number(values.parallel)) }, worker));
  return dir;
}

async function engineCommit(): Promise<{ commit: string; dirty: boolean }> {
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "ignore" });
    return (await new Response(proc.stdout).text()).trim();
  };
  const commit = await run("rev-parse", "HEAD");
  // Engine-relevant changes only: the web app doesn't change what a scan finds.
  const dirty = (await run("status", "--porcelain", "--", "packages/engine", "crates", "evals/src")).length > 0;
  return { commit, dirty };
}

const Targets = z.array(z.object({ name: z.string().regex(/^[a-z0-9-]+$/), path: z.string().min(1) }));

/** Real-world targets: local checkouts we own, scanned with no expected findings. */
async function privateTargets(): Promise<Benchmark[]> {
  const file = join(DATA_DIR, "targets.json");
  if (!existsSync(file)) throw new Error(`No ${file}. Create it as [{ "name": "my-app", "path": "/path/to/checkout" }].`);
  const targets = Targets.parse(JSON.parse(await readFile(file, "utf8")));
  return targets.map(({ name, path }) => ({ name, description: "", kind: "clean", source: { path }, advisories: [], tags: [], expected: [], decoys: [] }));
}

/** Per-benchmark table, misses and the judging queue; then the scorecard. */
async function summarise(dir: string, record: boolean): Promise<number> {
  const benchmarks = await loadBenchmarks();
  const run = await scoreRun(await readRun(dir), benchmarks);
  const table: string[][] = [["benchmark", "runs", "LOC", "shown", "recall", "precision", "dups", "unjudged", "fixed re-flagged"]];
  for (const name of run.benchmarks) {
    const list = run.scores.get(name)!;
    const s = list[0]!;
    const patched = run.patched.find((p) => p.name === name);
    const avg = (pick: (x: (typeof list)[number]) => number | null) => {
      const xs = list.map(pick).filter((x): x is number => x !== null);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    };
    const recall = avg((x) => x.recall);
    const precision = avg((x) => x.precision.lower);
    table.push([
      name,
      String(list.length),
      (await locOf(dir, name)).toLocaleString("en"),
      String(s.shown.total),
      recall === null ? "—" : `${pct(recall)} (${s.found.serious}/${s.expected.serious})`,
      precision === null ? "—" : pct(precision),
      String(s.shown.duplicates),
      String(s.shown.unjudged),
      patched ? `${patched.reflagged.length}/${patched.checked}` : "",
    ]);
  }
  console.log(`\n${align(table)}\n`);
  for (const [name, list] of run.scores) {
    const missed = list[0]!.missed;
    if (missed.length) console.log(`${name} missed: ${missed.map((m) => `${m.id} (${m.severity})`).join(", ")}`);
  }
  for (const t of run.targets) console.log(`target ${t.name}: ${t.all.total} findings, ${t.shown.total} shown, ${t.shown.unjudged} unjudged`);

  const unjudged = [...run.scores].flatMap(([name, list]) => list.flatMap((s) => s.findings.filter((f) => f.shown && f.outcome === "unjudged").map((f) => ({ name, ...f }))));
  if (unjudged.length) console.log(`\n${unjudged.length} shown findings unjudged: \`bun run judge ${run.id}\``);
  await writeFile(join(dir, "summary.json"), `${JSON.stringify({ aggregate: run.aggregate, stability: run.stability, patched: run.patched, cost: run.cost, medianMinutes: run.medianMinutes, scores: Object.fromEntries(run.scores) }, null, 2)}\n`);

  console.log("");
  const { regressions } = await scorecard(dir, values.baseline);
  if (record && !(await readHistory()).some((h) => h.id === run.id)) await appendHistory(run);
  return regressions.length;
}

async function locOf(dir: string, name: string): Promise<number> {
  const report = (await readRun(dir)).scans.get(name)?.[0];
  return report?.repo.loc ?? 0;
}

function align(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => (row[i] ?? "").length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// Last, so every declaration above is initialised before the top-level await runs.
const dir = values.rescore ? runDir(values.rescore) : await scanAll();
const regressions = await summarise(dir, !values.rescore && !values.private);
process.exit(regressions ? 1 : 0);
