/**
 * Deep scan of a local checkout or a git URL.
 *
 *   bun run scan <path | https://…> [--ref <ref>] [--out <file>] [--threat-model <file>]
 *                [--hunters <n>] [--hunter-turns <n>] [--concurrency <n>] [--no-osv] [--quiet]
 *
 * Writes the full report as JSON (default `.sandchest/scans/<time>.scan.json`,
 * which is gitignored) and prints a summary. Reports contain code excerpts:
 * never commit them.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LocalWorkspace } from "@sandchest/workspace/local";
import { startLocalIndexer } from "./indexer";
import { createLlmClient, loadLlmConfig } from "./llm";
import { createOsvClient, loadPricing, runScan, ThreatModelSchema, type ScanEvent, type ScanReport } from "./scan";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    ref: { type: "string" },
    out: { type: "string" },
    "threat-model": { type: "string" },
    hunters: { type: "string" },
    "hunter-turns": { type: "string" },
    concurrency: { type: "string" },
    "no-osv": { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
  },
});

const target = positionals[0];
if (!target) {
  console.error("usage: bun run scan <path | https://…> [--ref <ref>] [--out <file>] [--threat-model <file>] [--hunters <n>] [--hunter-turns <n>] [--concurrency <n>] [--no-osv] [--quiet]");
  process.exit(2);
}

const report = await scan(target);
const out = resolve(values.out ?? `${REPO_ROOT}/.sandchest/scans/${new Date().toISOString().replace(/[:.]/g, "-")}.scan.json`);
await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
printSummary(report, out);

async function scan(target: string): Promise<ScanReport> {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new Error("Interrupted")));

  await using workspace = /^https:\/\//.test(target) ? await LocalWorkspace.create() : undefined;
  let root = resolve(target);
  if (workspace) {
    log(`Cloning ${target}…`);
    await workspace.clone({ url: target, ref: values.ref }, { depth: 1 });
    root = workspace.root;
  }

  await using indexer = await startLocalIndexer(root);
  const threatModel = values["threat-model"] ? ThreatModelSchema.parse(JSON.parse(await readFile(values["threat-model"], "utf8"))) : undefined;
  const started = Date.now();

  // `return await`: the indexer and workspace must outlive the scan.
  return await runScan({
    client: createLlmClient(loadLlmConfig()),
    indexer: indexer.client,
    osv: values["no-osv"] ? undefined : createOsvClient(),
    threatModel,
    pricing: loadPricing(),
    limits: {
      ...(values.hunters && { maxHunters: positiveInt(values.hunters, "--hunters") }),
      ...(values["hunter-turns"] && { hunterTurns: positiveInt(values["hunter-turns"], "--hunter-turns") }),
      ...(values.concurrency && { concurrency: positiveInt(values.concurrency, "--concurrency") }),
    },
    signal: controller.signal,
    onEvent: (event) => log(describe(event), started),
  });
}

function describe(event: ScanEvent): string {
  switch (event.type) {
    case "finding": {
      const sink = event.finding.attackPath.at(-1)!;
      return `▲ ${event.finding.severity.toUpperCase()} (${event.finding.confidence} confidence) ${event.finding.title} — ${sink.file}:${sink.line}`;
    }
    case "warning":
      return `! ${event.message}`;
    default:
      return event.message;
  }
}

function log(message: string, since?: number): void {
  if (values.quiet) return;
  const stamp = since === undefined ? "" : `[${((Date.now() - since) / 1000).toFixed(0).padStart(4)}s] `;
  console.error(`${stamp}${message}`);
}

function printSummary(report: ScanReport, out: string): void {
  const { stats, timings, usage } = report;
  console.log(`\n${report.findings.length} findings (${stats.candidates} candidates, ${report.dismissed.length} ruled out, ${stats.rejectedByGate} rejected by the evidence gate)`);
  for (const finding of report.findings) {
    const sink = finding.attackPath.at(-1)!;
    console.log(`  ${finding.severity.padEnd(8)} ${finding.confidence.padEnd(6)} ${finding.title}  ${sink.file}:${sink.line}`);
  }
  if (report.leads.length > 0) {
    console.log(`\n${report.leads.length} leads`);
    for (const lead of report.leads.slice(0, 15)) console.log(`  ${lead.kind.padEnd(22)} ${lead.title}${lead.at ? `  ${lead.at}` : ""}`);
    if (report.leads.length > 15) console.log(`  … ${report.leads.length - 15} more in the report`);
  }
  const tokens = `${usage.total.inputTokens.toLocaleString("en")} in (${usage.total.cachedTokens.toLocaleString("en")} cached), ${usage.total.outputTokens.toLocaleString("en")} out, ${usage.total.requests} requests`;
  const cost = usage.costUsd === undefined ? "" : `, $${usage.costUsd.toFixed(3)}`;
  console.log(`\n${(timings.totalMs / 1000).toFixed(0)}s · ${tokens}${cost}\nReport: ${out}`);
}

function positiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`${flag} must be a positive integer`);
    process.exit(2);
  }
  return n;
}
