/**
 * Does each expected bug's entry point reach a hunter? Recall is capped by
 * coverage: a handler the access-control hunters never see is found only by
 * luck. This measures that ceiling without running a hunt, using the engine's
 * own route detection, candidate ordering, merge and hunter split, so a change
 * to any of them is measured in minutes for (almost) nothing.
 *
 *   bun run coverage [name|tag…] [--cap N] [--no-classify] [--baseline <id>]
 *
 * Per bug it prints where the vulnerable handler's file first appears:
 * - detected: in the routes the indexer found;
 * - candidate: in the classifier's candidate queue (no classifier call);
 * - reached: in the entry points given to the access-control hunters once
 *   recovered handlers are merged in (classifier answers come from the cache;
 *   only code not seen before is billed).
 * Defaults to the `cve` set. Results go to coverage/<id>.json in the data.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createClassifier, loadClassifierConfig, startLocalIndexer } from "@sandchest/engine";
import { accessControlGroups, classifyEntryPoints, entryPointCandidates, mergeRecovered, type RouteInfo } from "@sandchest/engine/scan";
import { loadBenchmarks, select, type Benchmark } from "./benchmark";
import { evalClassifier } from "./cache";
import { checkout } from "./checkout";
import { DATA_DIR, requireData } from "./data";

requireData();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cap: { type: "string" },
    "no-classify": { type: "boolean", default: false },
    baseline: { type: "string" },
    parallel: { type: "string", default: "4" },
    /** Also write the headline numbers as JSON here (for `bun run gate`). */
    summary: { type: "string" },
  },
});

const COVERAGE_DIR = join(DATA_DIR, "coverage");
const cap = values.cap ? Number(values.cap) : undefined;
const classifierConfig = values["no-classify"] ? null : loadClassifierConfig();
const classifier = evalClassifier(classifierConfig ? createClassifier(classifierConfig) : undefined);

interface Row {
  benchmark: string;
  bug: string;
  files: string[];
  detected: number | null;
  candidate: number | null;
  reached: number | null;
  /** Entry points the access-control hunters were given. */
  given: number;
}

/** 1-based position of the first entry whose file is one of `files`, or null. */
function rank<T>(items: T[], filesOf: (item: T) => string[], files: Set<string>): number | null {
  const i = items.findIndex((item) => filesOf(item).some((f) => files.has(f)));
  return i < 0 ? null : i + 1;
}

const fileOf = (at: string) => (at.includes(":") ? at.slice(0, at.lastIndexOf(":")) : at);
const routeFiles = (r: RouteInfo) => [fileOf(r.at), ...r.handlers.map((h) => fileOf(h.split(" @ ")[1] ?? ""))];

async function measure(benchmark: Benchmark): Promise<Row[]> {
  const root = await checkout(benchmark, "vulnerable");
  await using indexer = await startLocalIndexer(root);
  const routes = (await indexer.client.call<{ routes: RouteInfo[] }>("routes", { limit: 1000 })).routes;
  const candidates = (await entryPointCandidates(indexer.client, routes, cap ?? 1000)) ?? [];
  const recovery = classifier ? await classifyEntryPoints(indexer.client, classifier, routes, cap ? { maxCandidates: cap } : {}) : undefined;
  const plain = accessControlGroups(routes).flat();
  const merged = recovery ? accessControlGroups(mergeRecovered(routes, recovery.recovered)).flat() : plain;
  return benchmark.expected.map((bug) => {
    const files = new Set([...(bug.replay ? [bug.replay.entryPoint.file] : []), ...bug.locations.map((l) => l.file)]);
    return {
      benchmark: benchmark.name,
      bug: bug.id,
      files: [...files],
      detected: rank(plain, routeFiles, files),
      candidate: rank(candidates, (d) => [d.file], files),
      reached: rank(merged, routeFiles, files),
      given: merged.length,
    };
  });
}

const benchmarks = select(await loadBenchmarks(), positionals.length ? positionals : ["cve"]).filter((b) => b.kind === "vulnerable");
const rows: Row[] = [];
const queue = [...benchmarks];
await Promise.all(
  Array.from({ length: Math.max(1, Number(values.parallel) || 1) }, async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      try {
        rows.push(...(await measure(b)));
      } catch (error) {
        console.error(`${b.name}: ${(error as Error).message}`);
      }
    }
  }),
);
rows.sort((a, b) => a.benchmark.localeCompare(b.benchmark) || a.bug.localeCompare(b.bug));

const show = (n: number | null) => (n === null ? "—" : String(n));
let baseline: Map<string, Row> | undefined;
if (values.baseline) {
  const saved = JSON.parse(await readFile(join(COVERAGE_DIR, `${values.baseline.replace(/\.json$/, "")}.json`), "utf8")) as { rows: Row[] };
  baseline = new Map(saved.rows.map((r) => [`${r.benchmark}/${r.bug}`, r]));
}
console.log(`${"benchmark / bug".padEnd(52)} ${"detected".padStart(8)} ${"candidate".padStart(9)} ${"reached".padStart(8)}  of`);
for (const row of rows) {
  const before = baseline?.get(`${row.benchmark}/${row.bug}`);
  const change = before && (before.reached === null) !== (row.reached === null) ? (row.reached === null ? "  LOST" : "  GAINED") : "";
  console.log(`${`${row.benchmark} / ${row.bug}`.slice(0, 52).padEnd(52)} ${show(row.detected).padStart(8)} ${show(row.candidate).padStart(9)} ${show(row.reached).padStart(8)}  ${row.given}${change}`);
}
const count = (pick: (r: Row) => number | null) => rows.filter((r) => pick(r) !== null).length;
console.log(`\nReach an access-control hunter: ${count((r) => r.reached)}/${rows.length} (route rules alone: ${count((r) => r.detected)}/${rows.length}).`);
if (baseline) {
  const was = [...baseline.values()].filter((r) => r.reached !== null).length;
  console.log(`Baseline ${values.baseline}: ${was}/${baseline.size}.`);
}
if (classifier) console.log(`Classifier: ${classifier.misses} billed call(s), ${classifier.hits} from cache.`);

const id = new Date().toISOString().replace(/[:.]/g, "-");
await mkdir(COVERAGE_DIR, { recursive: true });
await writeFile(join(COVERAGE_DIR, `${id}.json`), `${JSON.stringify({ id, cap: cap ?? null, classify: !!classifier, rows }, null, 2)}\n`);
console.log(`Saved coverage/${id}.json`);
if (values.summary) {
  await writeFile(values.summary, `${JSON.stringify({ id, bugs: rows.length, reached: count((r) => r.reached), candidates: count((r) => r.candidate), detected: count((r) => r.detected), classified: !!classifier, billed: classifier?.misses ?? 0 })}\n`);
}
