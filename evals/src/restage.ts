/**
 * Replays the engine's final merge of repeat reports on a saved run, so a
 * change to it is measured in minutes and cents instead of a full set of
 * scans: every scan report in the run is consolidated with the current
 * engine and written to a new run, which is then scored against the
 * original.
 *
 *   bun run restage <run> [--parallel 6]
 *
 * Reports already consolidated are consolidated again (a no-op when nothing
 * is left to merge).
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { createLlmClient, loadLlmConfig } from "@sandchest/engine";
import { consolidateFindings, loadPricing, type ScanReport } from "@sandchest/engine/scan";
import { loadBenchmarks } from "./benchmark";
import { requireData, RUNS_DIR } from "./data";
import { readRun, scoreRun } from "./runs";
import { render, runDir } from "./scorecard";

requireData();
const { values, positionals } = parseArgs({ allowPositionals: true, options: { parallel: { type: "string", default: "6" } } });
if (!positionals[0]) throw new Error("Usage: bun run restage <run> [--parallel N]");
const source = runDir(positionals[0]);
const id = `${basename(source)}+consolidate-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const out = join(RUNS_DIR, id);
await mkdir(out, { recursive: true });

const client = createLlmClient(loadLlmConfig());
const pricing = loadPricing();
const files = (await readdir(source)).filter((f) => f.endsWith(".scan.json"));
let costUsd = 0;
let merged = 0;
const queue = [...files];
await Promise.all(
  Array.from({ length: Math.max(1, Number(values.parallel) || 1) }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const report = JSON.parse(await readFile(join(source, file), "utf8")) as ScanReport;
      const result = await consolidateFindings({ client, findings: report.findings });
      const usage = result.usage?.usage;
      if (usage && pricing) costUsd += ((usage.inputTokens - usage.cachedTokens) * pricing.input + usage.cachedTokens * pricing.cachedInput + usage.outputTokens * pricing.output) / 1_000_000;
      merged += result.merged.length;
      const next: ScanReport = { ...report, findings: result.findings, merged: [...(report.merged ?? []), ...result.merged] };
      await writeFile(join(out, file), `${JSON.stringify(next, null, 2)}\n`);
      console.log(`${file}: ${report.findings.length} → ${result.findings.length}`);
    }
  }),
);
const meta = JSON.parse(await readFile(join(source, "run.json"), "utf8").catch(() => "{}")) as Record<string, unknown>;
await writeFile(join(out, "run.json"), `${JSON.stringify({ ...meta, id, note: `consolidation replayed on ${basename(source)}` }, null, 2)}\n`);
console.log(`\nMerged ${merged} finding(s) across ${files.length} reports; model cost $${costUsd.toFixed(2)}. Run: ${id}\n`);

const benchmarks = await loadBenchmarks();
const [after, before] = await Promise.all([readRun(out), readRun(source)]);
const shared = new Set([...after.scans.keys()]);
console.log(render(await scoreRun(after, benchmarks, shared), await scoreRun(before, benchmarks, shared)).text);
