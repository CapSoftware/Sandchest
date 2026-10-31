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
type Outcome = "shown" | "hidden" | "dropped" | "rejected" | "error";
const rows: Array<{ group: string; label: Label; before: Outcome; after: Outcome; title: string; reason: string }> = [];
let cost = 0;

await Promise.all(
  groups.map(async (group) => {
    await using indexer = await startLocalIndexer(group.root);
    const { results, costUsd } = await verifyFindings({
      client,
      indexer: indexer.client,
      threatModel: group.report.threatModel,
      findings: group.items.map((item) => item.finding),
      pricing,
    });
    cost += costUsd ?? 0;
    results.forEach((result, i) => {
      const { finding, label } = group.items[i]!;
      rows.push({
        group: group.name,
        label,
        before: finding.confidence === "low" ? "hidden" : "shown",
        after: outcomeOf(result),
        title: finding.title,
        reason: result.error ?? result.rejected?.join("; ") ?? result.review?.verdict.reasoning.slice(0, 300) ?? "",
      });
    });
    console.error(`[${group.name}] ${group.items.length} findings replayed`);
  }),
);

function outcomeOf(result: Verification): Outcome {
  if (result.error) return "error";
  if (result.rejected) return "rejected";
  const verdict = result.review!.verdict;
  if (verdict.verdict === "disproved") return "dropped";
  return verdict.confidence === "low" ? "hidden" : "shown";
}

const tally = (label: Label, when: "before" | "after", outcomes: Outcome[]) =>
  rows.filter((r) => r.label === label && outcomes.includes(r[when])).length;
const real = rows.filter((r) => r.label === "real").length;
const fake = rows.filter((r) => r.label === "false").length;
const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((100 * n) / d)}%`);

console.log(`\n${"group".padEnd(22)} label  before  after    title`);
for (const r of [...rows].sort((a, b) => a.label.localeCompare(b.label) || a.group.localeCompare(b.group))) {
  console.log(`${r.group.padEnd(22)} ${r.label.padEnd(6)} ${r.before.padEnd(7)} ${r.after.padEnd(8)} ${r.title.slice(0, 90)}`);
}
const shownBefore = tally("real", "before", ["shown"]);
const shownAfter = tally("real", "after", ["shown"]);
console.log(`\nReal findings shown:   ${shownAfter}/${real} (${pct(shownAfter, real)}), before ${shownBefore}/${real}`);
console.log(`False findings shown:  ${tally("false", "after", ["shown"])}/${fake}, before ${tally("false", "before", ["shown"])}/${fake}`);
console.log(`False findings removed (dropped or hidden): ${pct(tally("false", "after", ["dropped", "hidden"]), fake)}`);
console.log(`Errors: ${rows.filter((r) => r.after === "error").length}. Cost: $${cost.toFixed(2)}`);

const outDir = values.private ? join(REPO_ROOT, "evals/private/results") : join(REPO_ROOT, "evals/results");
await mkdir(outDir, { recursive: true });
const out = join(outDir, `reverify-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(out, `${JSON.stringify(rows, null, 2)}\n`);
console.log(`Details: ${out}`);
