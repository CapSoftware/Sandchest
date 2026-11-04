/**
 * The scorecard: every quality number for a run, against a baseline run, both
 * re-scored now on the benchmarks they share.
 *
 *   bun run scorecard <run> [--baseline <run>|none]
 *
 * <run> is a directory under the eval data's runs/ (or a path). Without
 * --baseline, the latest earlier run in history.jsonl that shares a benchmark.
 */
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { loadBenchmarks } from "./benchmark";
import { HISTORY_FILE, REPO_ROOT, RUNS_DIR } from "./data";
import { readRun, scoreRun, type RunScore } from "./runs";

/** Targets (SPEC §19 for the first three). */
export const TARGETS = {
  recall: 0.7,
  precision: 0.8,
  medianMinutes: 15,
  duplicateRate: 0.05,
  testCodeRate: 0.02,
  patchedFpRate: 0.1,
  severityAccuracy: 0.7,
  fingerprintStability: 0.9,
};

/**
 * How far a number may move before we call it a regression. Single runs vary
 * about ±4 points in recall with no change at all (measured 2026-10-31), so
 * smaller moves on one run are noise: repeat runs (--repeat) before trusting them.
 */
const NOISE = { recall: 0.05, precision: 0.05, rate: 0.03, costShare: 0.25, timeShare: 0.25 };

interface Row {
  metric: string;
  value: number | null;
  baseline?: number | null;
  /** "higher" when bigger is better. */
  better: "higher" | "lower";
  target?: number;
  format: (n: number) => string;
  /** Absolute change that counts as real, or a share of the baseline for cost/time. */
  noise: number;
  relative?: boolean;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const usd = (n: number) => `$${n.toFixed(2)}`;
const mins = (n: number) => `${n.toFixed(1)}m`;

export function rows(run: RunScore, base?: RunScore): Row[] {
  const a = run.aggregate;
  const b = base?.aggregate;
  const fpStability = (r: RunScore) => mean(r.stability.map((s) => s.fingerprintStability));
  const agreement = (r: RunScore) => mean(r.stability.map((s) => s.agreement));
  const recognised = (r: RunScore) => mean(r.stability.map((s) => s.recognised ?? null));
  const list: Row[] = [
    { metric: "Recall, critical+high", value: a.recall, baseline: b?.recall, better: "higher", target: TARGETS.recall, format: pct, noise: NOISE.recall },
    { metric: "Recall, as shown by default", value: a.recallShown, baseline: b?.recallShown, better: "higher", format: pct, noise: NOISE.recall },
    { metric: "Precision, shown (strict)", value: a.precision.lower, baseline: b?.precision.lower, better: "higher", target: TARGETS.precision, format: pct, noise: NOISE.precision },
    { metric: "Precision, shown (judged only)", value: a.precision.known, baseline: b?.precision.known, better: "higher", format: pct, noise: NOISE.precision },
    { metric: "Precision, every severity (strict)", value: a.precisionAll.lower, baseline: b?.precisionAll.lower, better: "higher", format: pct, noise: NOISE.precision },
    { metric: "Duplicate rate, shown", value: a.duplicateRate, baseline: b?.duplicateRate, better: "lower", target: TARGETS.duplicateRate, format: pct, noise: NOISE.rate },
    { metric: "Test/fixture code, shown", value: a.testCodeRate, baseline: b?.testCodeRate, better: "lower", target: TARGETS.testCodeRate, format: pct, noise: NOISE.rate },
    { metric: "Severity matches expected", value: a.severity.accuracy, baseline: b?.severity.accuracy, better: "higher", target: TARGETS.severityAccuracy, format: pct, noise: NOISE.precision },
    { metric: "Fixed bugs re-flagged (FP on fixed code)", value: a.patchedFpRate, baseline: b?.patchedFpRate, better: "lower", target: TARGETS.patchedFpRate, format: pct, noise: NOISE.rate },
    { metric: "Same bug, same fingerprint across runs", value: fpStability(run), baseline: base ? fpStability(base) : undefined, better: "higher", format: pct, noise: NOISE.rate },
    { metric: "Same bug recognised on rescan", value: recognised(run), baseline: base ? recognised(base) : undefined, better: "higher", target: TARGETS.fingerprintStability, format: pct, noise: NOISE.rate },
    { metric: "Bugs found in every run (of any run)", value: agreement(run), baseline: base ? agreement(base) : undefined, better: "higher", format: pct, noise: NOISE.recall },
    { metric: "Cost", value: run.cost.usd, baseline: base?.cost.usd, better: "lower", format: usd, noise: NOISE.costShare, relative: true },
    { metric: "Cost per 100k LOC", value: run.cost.per100kLoc, baseline: base?.cost.per100kLoc, better: "lower", format: usd, noise: NOISE.costShare, relative: true },
    { metric: "Median scan time", value: run.medianMinutes, baseline: base?.medianMinutes, better: "lower", target: TARGETS.medianMinutes, format: mins, noise: NOISE.timeShare, relative: true },
  ];
  return list.filter((row) => row.value !== null || (row.baseline !== null && row.baseline !== undefined));
}

function mean(xs: Array<number | null>): number | null {
  const ys = xs.filter((x): x is number => x !== null);
  return ys.length ? ys.reduce((s, x) => s + x, 0) / ys.length : null;
}

export type Verdict = "better" | "worse" | "same";

function compare(row: Row): Verdict | null {
  if (row.value === null || row.baseline === null || row.baseline === undefined) return null;
  const delta = row.value - row.baseline;
  const threshold = row.relative ? Math.abs(row.baseline) * row.noise : row.noise;
  if (Math.abs(delta) < threshold || delta === 0) return "same";
  return (delta > 0) === (row.better === "higher") ? "better" : "worse";
}

function meets(row: Row): string {
  if (row.target === undefined || row.value === null) return "";
  const ok = row.better === "higher" ? row.value >= row.target : row.value <= row.target;
  return `${ok ? "✓" : "✗"} ${row.better === "higher" ? "≥" : "≤"} ${row.format(row.target)}`;
}

export function render(run: RunScore, base?: RunScore): { text: string; regressions: string[] } {
  const table: string[][] = [["", "this run", base ? `baseline ${base.id}` : "", base ? "change" : "", "target"]];
  const regressions: string[] = [];
  for (const row of rows(run, base)) {
    const verdict = compare(row);
    if (verdict === "worse") regressions.push(row.metric);
    const change = verdict === null ? "" : verdict === "same" ? "≈" : `${verdict === "better" ? "▲ better" : "▼ worse"}`;
    table.push([row.metric, row.value === null ? "—" : row.format(row.value), base ? (row.baseline == null ? "—" : row.format(row.baseline)) : "", change, meets(row)]);
  }
  const lines = [align(table)];
  const a = run.aggregate;
  const unjudged = a.unjudged;
  lines.push("");
  lines.push(`Shown findings: ${a.shown}; unjudged ${unjudged}${unjudged ? " (strict precision counts them as false: judge them with `bun run judge`)" : ""}.`);
  lines.push(`Severity of matched bugs: ${a.severity.exact} as expected, ${a.severity.under} under-rated, ${a.severity.over} over-rated.`);
  if (a.patchedChecked) lines.push(`Fixed commits: ${a.patchedChecked} fixed bugs checked; re-flagged: ${run.patched.flatMap((p) => p.reflagged.map((id) => `${p.name}/${id}`)).join(", ") || "none"}.`);
  for (const s of run.stability) {
    lines.push(`Stability ${s.name}: ${s.runs} runs, recall ${s.recalls.map(pct).join(" / ")}, union ${s.unionRecall === null ? "—" : pct(s.unionRecall)}, same fingerprint ${s.fingerprintStability === null ? "—" : pct(s.fingerprintStability)}, recognised on rescan ${s.recognised == null ? "—" : pct(s.recognised)}.`);
  }
  const runs = Math.max(1, ...[...run.scores.values()].map((list) => list.length));
  if (base && runs === 1) lines.push("Single run per benchmark: recall moves about ±4 points with no change. Use --repeat 2+ before trusting a small change.");
  if (regressions.length) lines.push(`\nRegressions beyond noise: ${regressions.join(", ")}.`);
  return { text: lines.join("\n"), regressions };
}

function align(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => (row[i] ?? "").length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

export interface HistoryEntry {
  id: string;
  at: string;
  commit?: string;
  dirty?: boolean;
  note?: string;
  benchmarks: string[];
  repeat: number;
  recall: number | null;
  recallShown: number | null;
  precision: number | null;
  precisionKnown: number | null;
  duplicateRate: number | null;
  testCodeRate: number | null;
  severityAccuracy: number | null;
  patchedFpRate: number | null;
  costUsd: number | null;
  medianMinutes: number | null;
}

export async function readHistory(): Promise<HistoryEntry[]> {
  if (!existsSync(HISTORY_FILE)) return [];
  return (await readFile(HISTORY_FILE, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HistoryEntry);
}

export async function appendHistory(run: RunScore): Promise<void> {
  const a = run.aggregate;
  const entry: HistoryEntry = {
    id: run.id,
    at: run.meta?.startedAt ?? new Date().toISOString(),
    commit: run.meta?.commit,
    dirty: run.meta?.dirty,
    note: run.meta?.note,
    benchmarks: run.benchmarks,
    repeat: run.meta?.repeat ?? 1,
    recall: a.recall,
    recallShown: a.recallShown,
    precision: a.precision.lower,
    precisionKnown: a.precision.known,
    duplicateRate: a.duplicateRate,
    testCodeRate: a.testCodeRate,
    severityAccuracy: a.severity.accuracy,
    patchedFpRate: a.patchedFpRate,
    costUsd: run.cost.usd,
    medianMinutes: run.medianMinutes,
  };
  await appendFile(HISTORY_FILE, `${JSON.stringify(entry)}\n`);
}

export function runDir(arg: string): string {
  if (isAbsolute(arg)) return arg;
  const inRuns = join(RUNS_DIR, arg);
  return existsSync(inRuns) ? inRuns : resolve(process.env.INIT_CWD ?? REPO_ROOT, arg);
}

/** Scores `dir` and its baseline on the benchmarks they share, and prints the scorecard. */
export async function scorecard(dir: string, baseline?: string): Promise<{ run: RunScore; regressions: string[] }> {
  const benchmarks = await loadBenchmarks();
  const scans = await readRun(dir);
  let run = await scoreRun(scans, benchmarks);
  let base: RunScore | undefined;
  if (baseline !== "none") {
    const baseDir = baseline ? runDir(baseline) : await latestBaseline(run.id, run.benchmarks);
    if (baseDir) {
      const shared = new Set(run.benchmarks.filter((name) => existsSync(join(baseDir, `${name}.scan.json`))));
      if (shared.size > 0) {
        base = await scoreRun(await readRun(baseDir), benchmarks, shared);
        if (shared.size < run.benchmarks.length) {
          console.log(`Compared on the ${shared.size} benchmark(s) both runs have: ${[...shared].join(", ")}.\n`);
          run = await scoreRun(scans, benchmarks, shared);
        }
      }
    }
  }
  const { text, regressions } = render(run, base);
  console.log(text);
  return { run, regressions };
}

async function latestBaseline(id: string, names: string[]): Promise<string | undefined> {
  const history = (await readHistory()).filter((h) => h.id !== id && h.benchmarks.some((b) => names.includes(b)));
  const last = history.at(-1);
  return last ? join(RUNS_DIR, last.id) : undefined;
}

if (import.meta.main) {
  const { parseArgs } = await import("node:util");
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { baseline: { type: "string" } } });
  if (!positionals[0]) {
    console.error("Usage: bun run scorecard <run> [--baseline <run>|none]");
    process.exit(2);
  }
  const { regressions } = await scorecard(runDir(positionals[0]), values.baseline);
  process.exit(regressions.length ? 1 : 0);
}
