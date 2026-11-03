/**
 * Measures the skeptic on labelled findings, without re-running the hunt.
 *
 *   bun run reverify --run evals/results/<run>   benchmark findings from a saved run
 *                    [--private]                  plus labelled real-world findings
 *
 * Labels: benchmark findings that match an expected vulnerability are real.
 * False labels come only from human-verified findings in
 * evals/private/labels/<target>.json ({ fingerprint: { label, scan } }):
 * decoy hits are not used, because several turned out to be real bugs in
 * the "safe" code.
 *
 * Every finding was shown by the skeptic that produced it, so this is a
 * paired comparison: how many real findings the current skeptic still shows
 * (retention), and how many false ones it now drops or hides (removal).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createLlmClient, loadLlmConfig, startLocalIndexer } from "@sandchest/engine";
import { loadPricing, verifyFindings, type Finding, type ScanReport, type Verification } from "@sandchest/engine/scan";
import { loadBenchmarks } from "./benchmark";
import { checkout, REPO_ROOT } from "./checkout";
import { score } from "./score";

const { values } = parseArgs({
  options: {
    run: { type: "string" },
    private: { type: "boolean", default: false },
    severities: { type: "string", default: "critical,high" },
    ground: { type: "boolean", default: false },
    repeat: { type: "string", default: "1" },
  },
});

type Label = "real" | "false";

interface Group {
  name: string;
  root: string;
  report: ScanReport;
  items: Array<{ finding: Finding; label: Label }>;
}

const severities = new Set(values.severities!.split(","));
const groups: Group[] = [];

if (values.run) {
  const dir = resolve(process.env.INIT_CWD ?? REPO_ROOT, values.run);
  for (const benchmark of (await loadBenchmarks()).filter((b) => b.kind === "vulnerable")) {
    const file = join(dir, `${benchmark.name}.scan.json`);
    if (!existsSync(file)) continue;
    const report = JSON.parse(await readFile(file, "utf8")) as ScanReport;
    const scored = score(benchmark, report);
    const items = report.findings.flatMap((finding, i): Group["items"] => {
      const verdict = scored.findings[i]!;
      return severities.has(finding.severity) && verdict.matches.length > 0 ? [{ finding, label: "real" }] : [];
    });
    if (items.length > 0) groups.push({ name: benchmark.name, root: await checkout(benchmark), report, items });
  }
  // Clean, well-maintained repos should surface no serious bugs: any shown finding here is a false
  // positive (this is what the clean benchmarks are for — measuring the FP rate).
  for (const benchmark of (await loadBenchmarks()).filter((b) => b.kind === "clean")) {
    const file = join(dir, `${benchmark.name}.scan.json`);
    if (!existsSync(file)) continue;
    const report = JSON.parse(await readFile(file, "utf8")) as ScanReport;
    const items = report.findings.flatMap((finding): Group["items"] => (severities.has(finding.severity) ? [{ finding, label: "false" as const }] : []));
    if (items.length > 0) groups.push({ name: benchmark.name, root: await checkout(benchmark), report, items });
  }
}

if (values.private) {
  const targets = JSON.parse(await readFile(join(REPO_ROOT, "evals/private/targets.json"), "utf8")) as Array<{ name: string; path: string }>;
  for (const target of targets) {
    const labelFile = join(REPO_ROOT, "evals/private/labels", `${target.name}.json`);
    if (!existsSync(labelFile)) continue;
    const labels = JSON.parse(await readFile(labelFile, "utf8")) as Record<string, { label: Label; scan: string }>;
    // Labelled findings live in several scans; replay each scan's with that scan's threat model.
    for (const scan of [...new Set(Object.values(labels).map((l) => l.scan))]) {
      const report = JSON.parse(await readFile(join(REPO_ROOT, "evals/private/results", scan, `${target.name}.scan.json`), "utf8")) as ScanReport;
      const items = report.findings.filter((f) => labels[f.fingerprint]).map((finding) => ({ finding, label: labels[finding.fingerprint]!.label }));
      if (items.length > 0) groups.push({ name: `${target.name}@${scan.slice(11, 19)}`, root: target.path, report, items });
    }
  }
}

if (groups.length === 0) {
  console.error("Nothing to replay. Pass --run <results dir> and/or --private.");
  process.exit(2);
}

const client = createLlmClient(loadLlmConfig());
const pricing = loadPricing();
const repeat = Math.max(1, Math.floor(Number(values.repeat)) || 1);
type Outcome = "shown" | "hidden" | "dropped" | "rejected" | "error";
// Each finding, reviewed `repeat` times: keepRate is the fraction of runs that still showed it.
const rows: Array<{ group: string; label: Label; title: string; keepRate: number }> = [];
let cost = 0;

await Promise.all(
  groups.map(async (group) => {
    await using indexer = await startLocalIndexer(group.root);
    const kept = new Array<number>(group.items.length).fill(0);
    for (let run = 0; run < repeat; run++) {
      const { results, costUsd } = await verifyFindings({
        client,
        indexer: indexer.client,
        threatModel: group.report.threatModel,
        findings: group.items.map((item) => item.finding),
        pricing,
        investigateAuth: values.ground,
      });
      cost += costUsd ?? 0;
      results.forEach((result, i) => {
        if (outcomeOf(result) === "shown") kept[i]!++;
      });
    }
    group.items.forEach((item, i) => {
      rows.push({ group: group.name, label: item.label, title: item.finding.title, keepRate: kept[i]! / repeat });
    });
    console.error(`[${group.name}] ${group.items.length} findings × ${repeat}`);
  }),
);

function outcomeOf(result: Verification): Outcome {
  if (result.error) return "error";
  if (result.rejected) return "rejected";
  const verdict = result.review!.verdict;
  if (verdict.verdict !== "confirmed") return "dropped";
  return verdict.confidence === "low" ? "hidden" : "shown";
}

const reals = rows.filter((r) => r.label === "real");
const fakes = rows.filter((r) => r.label === "false");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (x: number) => `${Math.round(100 * x)}%`;
// Majority vote across the repeats: a finding "survives" if shown in >half the runs.
const survives = (r: { keepRate: number }) => r.keepRate > 0.5;
// Unstable = the skeptic disagreed with itself across runs (not pinned to keep or drop).
const unstable = (r: { keepRate: number }) => r.keepRate > 0 && r.keepRate < 1;

console.log(`\n${"group".padEnd(22)} label  keep%  title`);
for (const r of [...rows].sort((a, b) => a.label.localeCompare(b.label) || a.group.localeCompare(b.group))) {
  console.log(`${r.group.padEnd(22)} ${r.label.padEnd(6)} ${pct(r.keepRate).padStart(4)}  ${r.title.slice(0, 84)}`);
}
console.log(`\nRepeats per finding: ${repeat}${values.ground ? " (auth-grounded)" : ""}`);
console.log(`REAL  (${reals.length}): recall ${pct(mean(reals.map((r) => (survives(r) ? 1 : 0))))} by majority; mean keep-rate ${pct(mean(reals.map((r) => r.keepRate)))}`);
console.log(`FALSE (${fakes.length}): removed ${pct(mean(fakes.map((r) => (survives(r) ? 0 : 1))))} by majority; mean keep-rate ${pct(mean(fakes.map((r) => r.keepRate)))} (lower is better)`);
console.log(`Self-disagreement (shown in some runs, not others): real ${reals.filter(unstable).length}/${reals.length}, false ${fakes.filter(unstable).length}/${fakes.length}`);
console.log(`Cost: $${cost.toFixed(2)}`);

const outDir = values.private ? join(REPO_ROOT, "evals/private/results") : join(REPO_ROOT, "evals/results");
await mkdir(outDir, { recursive: true });
const out = join(outDir, `reverify-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(out, `${JSON.stringify(rows, null, 2)}\n`);
console.log(`Details: ${out}`);
