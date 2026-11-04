/**
 * The cheap check every engine change passes before a full benchmark run.
 * In one go, for a few dollars instead of a full set of scans:
 * - coverage: do the expected bugs' entry points reach a hunter (no hunt;
 *   classifier answers cached, so it is free after the first run);
 * - reverify: the skeptic replayed on a saved run's labelled findings — real
 *   ones it keeps, false ones it removes, severity it gets right;
 * - fpcheck: known bugs replayed on their vulnerable and their fixed code.
 *
 *   bun run gate [--accept] [--repeat 2] [--no-classify]
 *
 * Results are compared with gate/baseline.json and the command fails on a
 * regression beyond run-to-run noise. `--accept` saves this result as the new
 * baseline (do that once a change is validated by a full run). The saved run
 * the skeptic is replayed on is `reverifyRun` in gate/config.json.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DATA_DIR, requireData } from "./data";

requireData();
const { values } = parseArgs({ options: { accept: { type: "boolean", default: false }, repeat: { type: "string", default: "2" }, "no-classify": { type: "boolean", default: false } } });

const GATE_DIR = join(DATA_DIR, "gate");
await mkdir(GATE_DIR, { recursive: true });
const config = JSON.parse(await readFile(join(GATE_DIR, "config.json"), "utf8")) as { reverifyRun: string };
const id = new Date().toISOString().replace(/[:.]/g, "-");
const tmp = (name: string) => join(GATE_DIR, `.${id}-${name}.json`);

interface Coverage { bugs: number; reached: number; candidates: number; detected: number; classified: boolean }
interface Reverify { real: number; realKept: number; realKeepRate?: number; falseKeepRate?: number; false: number; falseRemoved: number; unstable: number; severityExact: number | null; costUsd: number; details?: string }
interface FpCheck { pairs: number; recall: number; falsePositives: number; costUsd: number }
interface Result { id: string; coverage: Coverage; reverify: Reverify; fpcheck: FpCheck }

async function step<T>(name: string, args: string[]): Promise<T> {
  const out = tmp(name);
  const proc = Bun.spawn(["bun", "--env-file=../.env.local", `src/${name}.ts`, ...args, "--summary", out], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  await writeFile(join(GATE_DIR, `${id}-${name}.log`), stdout + stderr);
  if (code !== 0 || !existsSync(out)) throw new Error(`${name} failed (exit ${code}); see gate/${id}-${name}.log\n${stderr.slice(-800)}`);
  const summary = JSON.parse(await readFile(out, "utf8")) as T;
  await Bun.file(out).delete();
  return summary;
}

console.error("Running coverage, reverify and fpcheck…");
const [coverage, reverify, fpcheck] = await Promise.all([
  step<Coverage>("coverage", values["no-classify"] ? ["--no-classify"] : []),
  step<Reverify>("reverify", ["--run", config.reverifyRun, "--severities", "critical,high,medium,low", "--repeat", values.repeat!]),
  step<FpCheck>("fpcheck", ["--repeat", values.repeat!]),
]);
const result: Result = { id, coverage, reverify, fpcheck };
await writeFile(join(GATE_DIR, `${id}.json`), `${JSON.stringify(result, null, 2)}\n`);

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(100 * x)}%`);
const basePath = join(GATE_DIR, "baseline.json");
const base = existsSync(basePath) ? (JSON.parse(await readFile(basePath, "utf8")) as Result) : undefined;
const failures: string[] = [];
const line = (label: string, now: string, was: string | undefined, bad: boolean, why?: string) => {
  console.log(`${label.padEnd(44)} ${now.padStart(9)} ${(was ?? "").padStart(9)}${bad ? "  REGRESSION" : ""}`);
  if (bad) failures.push(why ?? label);
};

console.log(`\n${"".padEnd(44)} ${"now".padStart(9)} ${"baseline".padStart(9)}`);
const b = base;
// Deterministic given the classifier cache: any loss is real.
line("Bugs whose handler reaches a hunter", `${coverage.reached}/${coverage.bugs}`, b && `${b.coverage.reached}/${b.coverage.bugs}`, !!b && coverage.reached < b.coverage.reached);
line("Bugs whose handler is a classifier candidate", `${coverage.candidates}/${coverage.bugs}`, b && `${b.coverage.candidates}/${b.coverage.bugs}`, !!b && coverage.candidates < b.coverage.candidates);
// The skeptic is sampled: compare mean keep-rates over every finding and repeat, allowing 4 points of noise
// (two runs of the same engine differed by 2).
const sameSet = b && b.reverify.real === reverify.real && b.reverify.false === reverify.false;
const rate = (r: Reverify, key: "realKeepRate" | "falseKeepRate") => r[key] ?? (key === "realKeepRate" ? r.realKept / r.real : 1 - r.falseRemoved / r.false);
line("Real findings the skeptic keeps (mean)", pct(rate(reverify, "realKeepRate")), b && pct(rate(b.reverify, "realKeepRate")), !!sameSet && rate(reverify, "realKeepRate") < rate(b!.reverify, "realKeepRate") - 0.04);
line("False findings it still shows (mean)", pct(rate(reverify, "falseKeepRate")), b && pct(rate(b.reverify, "falseKeepRate")), !!sameSet && rate(reverify, "falseKeepRate") > rate(b!.reverify, "falseKeepRate") + 0.04);
line("Real findings kept in every repeat", `${reverify.realKept}/${reverify.real}`, b && `${b.reverify.realKept}/${b.reverify.real}`, false);
line("False findings removed in a majority", `${reverify.falseRemoved}/${reverify.false}`, b && `${b.reverify.falseRemoved}/${b.reverify.false}`, false);
line("Severity exactly right (real findings)", pct(reverify.severityExact), b && pct(b.reverify.severityExact), !!b && reverify.severityExact !== null && b.reverify.severityExact !== null && reverify.severityExact < b.reverify.severityExact - 0.1);
line("Skeptic disagrees with itself", String(reverify.unstable), b && String(b.reverify.unstable), false);
line("Known bugs confirmed on vulnerable code", pct(fpcheck.recall), b && pct(b.fpcheck.recall), !!b && fpcheck.pairs === b.fpcheck.pairs && fpcheck.recall < b.fpcheck.recall - 0.1);
line("Known bugs confirmed on fixed code (FP)", pct(fpcheck.falsePositives), b && pct(b.fpcheck.falsePositives), !!b && fpcheck.pairs === b.fpcheck.pairs && fpcheck.falsePositives > b.fpcheck.falsePositives + 0.1);
// A finding that moved the wrong way since the baseline is re-checked on its own with more repeats, so a
// sampling wobble is told apart from a real change (a few cents for the handful that move).
const moved = await recheckMoved();
const recheckCost = moved?.costUsd ?? 0;
console.log(`\nCost: $${(reverify.costUsd + fpcheck.costUsd + recheckCost).toFixed(2)}${coverage.classified ? "" : " (coverage ran without the classifier)"}. Result: gate/${id}.json`);
if (!b && !sameSet) console.log("No comparable baseline: run with --accept to save one.");
if (sameSet === false) console.log(`The replayed findings changed (reverifyRun or labels), so the skeptic rows are not compared.`);

async function recheckMoved(): Promise<{ costUsd: number } | undefined> {
  if (!b?.reverify.details || !reverify.details || !existsSync(join(DATA_DIR, b.reverify.details))) return undefined;
  type Row = { group: string; label: "real" | "false"; title: string; keepRate: number };
  const load = async (file: string) => new Map((JSON.parse(await readFile(join(DATA_DIR, file), "utf8")) as Row[]).map((r) => [`${r.group}|${r.title}`, r]));
  const [before, now] = await Promise.all([load(b.reverify.details), load(reverify.details)]);
  const worse = [...now.entries()].filter(([key, r]) => {
    const was = before.get(key);
    return was && (r.label === "real" ? r.keepRate <= was.keepRate - 0.5 : r.keepRate >= was.keepRate + 0.5);
  });
  if (worse.length === 0) {
    console.log("\nNo finding moved the wrong way since the baseline.");
    return { costUsd: 0 };
  }
  const keys = tmp("recheck-keys");
  await writeFile(keys, JSON.stringify(worse.map(([key]) => key)));
  const again = await step<Reverify>("reverify", ["--run", config.reverifyRun, "--severities", "critical,high,medium,low", "--repeat", "4", "--only", keys]);
  await Bun.file(keys).delete();
  const rechecked = again.details ? await load(again.details) : new Map<string, Row>();
  console.log(`\nFindings that moved the wrong way, re-checked 4 more times (baseline → this run → re-check):`);
  let confirmed = 0;
  for (const [key, r] of worse) {
    const was = before.get(key)!.keepRate;
    const check = rechecked.get(key)?.keepRate;
    // Kept-rate over all six reviews of this engine, against the baseline's.
    const overall = check === undefined ? r.keepRate : (2 * r.keepRate + 4 * check) / 6;
    const real = r.label === "real" ? overall <= was - 0.5 : overall >= was + 0.5;
    if (real) confirmed++;
    console.log(`  ${r.label.padEnd(5)} ${pct(was).padStart(4)} → ${pct(r.keepRate).padStart(4)} → ${check === undefined ? "  —" : pct(check).padStart(4)}  ${real ? "CHANGED" : "noise  "}  ${r.title.slice(0, 70)}`);
  }
  console.log(`${confirmed} of ${worse.length} held up on re-check.`);
  return { costUsd: again.costUsd };
}

if (values.accept) {
  await writeFile(basePath, `${JSON.stringify(result, null, 2)}\n`);
  console.log("Saved as the new baseline.");
}
if (failures.length) {
  console.log(`\nFAIL: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nPASS");
