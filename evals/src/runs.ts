/**
 * A run is a directory under the eval data's `runs/`: one scan report per
 * benchmark and repeat (`<name>.scan.json`, `<name>.r2.scan.json`, …), an
 * optional scan of the fixed commit (`<name>.patched.scan.json`), and
 * `run.json` describing how it was made. Scoring always reads the saved
 * reports with the current scorer and judgements, so two runs are compared
 * like for like however old they are.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { adoptKnownFingerprints, type ScanReport } from "@sandchest/engine/scan";
import type { Benchmark } from "./benchmark";
import { JUDGEMENTS_DIR, LABELS_DIR } from "./data";
import { aggregate, ratio, score, scorePatched, stability, type Aggregate, type BenchmarkScore, type Judgements, type PatchedScore, type Stability } from "./score";

export interface RunMeta {
  id: string;
  startedAt: string;
  /** Engine commit and whether the working tree had uncommitted changes. */
  commit: string;
  dirty: boolean;
  /** Model roles and limits used (env values, so they can be compared across runs). */
  config: Record<string, string | number | boolean | null>;
  benchmarks: string[];
  repeat: number;
  note?: string;
}

export interface RunScans {
  dir: string;
  meta?: RunMeta;
  /** Benchmark name → its repeated scans, in repeat order. */
  scans: Map<string, ScanReport[]>;
  patched: Map<string, ScanReport>;
}

export async function readRun(dir: string): Promise<RunScans> {
  const scans = new Map<string, ScanReport[]>();
  const patched = new Map<string, ScanReport>();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".scan.json")).sort();
  for (const file of files) {
    const match = /^(.+?)(?:\.r(\d+))?(\.patched)?\.scan\.json$/.exec(file);
    if (!match) continue;
    const [, name, repeat, isPatched] = match;
    const report = JSON.parse(await readFile(join(dir, file), "utf8")) as ScanReport;
    if (isPatched) patched.set(name!, report);
    else {
      const list = scans.get(name!) ?? [];
      list[repeat ? Number(repeat) - 1 : 0] = report;
      scans.set(name!, list);
    }
  }
  for (const [name, list] of scans) scans.set(name, list.filter(Boolean));
  const metaFile = join(dir, "run.json");
  const meta = existsSync(metaFile) ? (JSON.parse(await readFile(metaFile, "utf8")) as RunMeta) : undefined;
  return { dir, meta, scans, patched };
}

/** Human judgements for a benchmark or target, merging the older `labels/<name>.json` format. */
export async function loadJudgements(name: string): Promise<Judgements> {
  const out: Judgements = {};
  const labels = join(LABELS_DIR, `${name}.json`);
  if (existsSync(labels)) {
    const raw = JSON.parse(await readFile(labels, "utf8")) as Record<string, { label?: string; verdict?: string }>;
    for (const [fingerprint, value] of Object.entries(raw)) {
      const verdict = value.verdict ?? (value.label === "real" ? "real" : value.label === "false" ? "false_positive" : undefined);
      if (verdict) out[fingerprint] = { ...(value as object), verdict } as Judgements[string];
    }
  }
  const file = join(JUDGEMENTS_DIR, `${name}.json`);
  if (existsSync(file)) Object.assign(out, JSON.parse(await readFile(file, "utf8")) as Judgements);
  return out;
}

export interface RunScore {
  id: string;
  meta?: RunMeta;
  benchmarks: string[];
  /** Every repeat's score, per benchmark. */
  scores: Map<string, BenchmarkScore[]>;
  patched: PatchedScore[];
  stability: Stability[];
  aggregate: Aggregate;
  cost: { usd: number | null; per100kLoc: number | null };
  medianMinutes: number | null;
  /** Scans of targets that aren't benchmarks (real repositories), scored only by judgements. */
  targets: BenchmarkScore[];
}

/**
 * Scores a run. `only` restricts it to some benchmarks (to compare two runs
 * on what they share).
 */
export async function scoreRun(run: RunScans, benchmarks: Benchmark[], only?: Set<string>): Promise<RunScore> {
  const known = new Map(benchmarks.map((b) => [b.name, b]));
  const scores = new Map<string, BenchmarkScore[]>();
  const stab: Stability[] = [];
  const targets: BenchmarkScore[] = [];
  const reports: ScanReport[] = [];
  for (const [name, list] of run.scans) {
    if (only && !only.has(name)) continue;
    const judgements = await loadJudgements(name);
    const benchmark = known.get(name);
    if (!benchmark) {
      const target: Benchmark = { name, description: "", kind: "clean", source: { path: "." }, advisories: [], tags: [], expected: [], decoys: [] };
      targets.push(score(target, list[0]!, judgements));
      continue;
    }
    const scored = list.map((report) => score(benchmark, report, judgements));
    scores.set(name, scored);
    reports.push(...list);
    if (list.length > 1 && benchmark.kind === "vulnerable") {
      // What the product stores on a rescan: later runs' findings recognised against the first run's.
      const recognised = [scored[0]!, ...list.slice(1).map((report) => score(benchmark, { ...report, findings: adoptKnownFingerprints(report.findings, list[0]!.findings) }, judgements))];
      stab.push({ ...stability(benchmark, scored), recognised: stability(benchmark, recognised).fingerprintStability });
    }
  }
  const patched: PatchedScore[] = [];
  for (const [name, report] of run.patched) {
    const benchmark = known.get(name);
    if (benchmark && (!only || only.has(name))) patched.push(scorePatched(benchmark, report));
  }
  const costs = reports.map((r) => r.usage.costUsd);
  const usd = costs.every((c) => c !== undefined) && costs.length ? costs.reduce((a, b) => a + b!, 0) : null;
  const loc = reports.reduce((n, r) => n + r.repo.loc, 0);
  const minutes = reports.map((r) => r.durationMs / 60_000).sort((a, b) => a - b);
  return {
    id: basename(run.dir),
    meta: run.meta,
    benchmarks: [...scores.keys()].sort(),
    scores,
    patched,
    stability: stab,
    aggregate: aggregate([...scores.values()].flat(), patched),
    cost: { usd, per100kLoc: usd === null ? null : ratio(usd * 100_000, loc) },
    medianMinutes: minutes.length ? minutes[Math.floor((minutes.length - 1) / 2)]! : null,
    targets,
  };
}
