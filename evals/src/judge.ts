/**
 * Judging: the human (or reviewing agent) ground truth behind precision.
 *
 *   bun run judge <run> [benchmark…] [--all]     write <run>/judge.md: every unjudged shown finding (--all: any severity), in full
 *   bun run judge set <benchmark> <fingerprint> <verdict> [--dup <fingerprint>] [--severity <s>] [--note "…"] [--by <who>]
 *   bun run judge apply <file.json>              merge { "<benchmark>": { "<fingerprint>": { verdict, … } } }
 *
 * Verdicts: real, false_positive, not_security, test_code, duplicate. Saved in
 * judgements/<benchmark>.json in the eval data; fingerprints are stable, so a
 * verdict carries over to every later run that reports the same finding.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SEVERITIES, type Finding } from "@sandchest/engine/scan";
import { loadBenchmarks } from "./benchmark";
import { JUDGEMENTS_DIR, requireData } from "./data";
import { readRun, scoreRun } from "./runs";
import { VERDICTS, type JudgementRecord, type Judgements, type Verdict } from "./score";
import { runDir } from "./scorecard";

requireData();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { all: { type: "boolean", default: false }, dup: { type: "string" }, severity: { type: "string" }, note: { type: "string" }, by: { type: "string" } },
});

async function read(name: string): Promise<Judgements> {
  const file = join(JUDGEMENTS_DIR, `${name}.json`);
  return existsSync(file) ? (JSON.parse(await readFile(file, "utf8")) as Judgements) : {};
}

async function save(name: string, judgements: Judgements): Promise<void> {
  await mkdir(JUDGEMENTS_DIR, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(judgements).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(join(JUDGEMENTS_DIR, `${name}.json`), `${JSON.stringify(sorted, null, 2)}\n`);
}

function check(record: JudgementRecord, where: string): void {
  if (!VERDICTS.includes(record.verdict)) throw new Error(`${where}: verdict must be one of ${VERDICTS.join(", ")}`);
  if (record.verdict === "duplicate" && !record.duplicateOf) throw new Error(`${where}: a duplicate needs duplicateOf`);
  if (record.severity && !SEVERITIES.includes(record.severity)) throw new Error(`${where}: severity must be one of ${SEVERITIES.join(", ")}`);
}

const today = new Date().toISOString().slice(0, 10);
const [command, ...rest] = positionals;

if (command === "set") {
  const [name, fingerprint, verdict] = rest;
  if (!name || !fingerprint || !verdict) throw new Error("Usage: bun run judge set <benchmark> <fingerprint> <verdict> [--dup <fp>] [--severity <s>] [--note …]");
  const record: JudgementRecord = {
    verdict: verdict as Verdict,
    ...(values.dup && { duplicateOf: values.dup }),
    ...(values.severity && { severity: values.severity as Finding["severity"] }),
    ...(values.note && { note: values.note }),
    by: values.by ?? "human",
    at: today,
  };
  check(record, fingerprint);
  const judgements = await read(name);
  judgements[fingerprint] = record;
  await save(name, judgements);
  console.log(`${name} ${fingerprint}: ${verdict}`);
} else if (command === "apply") {
  const batch = JSON.parse(await readFile(rest[0]!, "utf8")) as Record<string, Record<string, JudgementRecord>>;
  for (const [name, records] of Object.entries(batch)) {
    const judgements = await read(name);
    for (const [fingerprint, record] of Object.entries(records)) {
      check(record, `${name}/${fingerprint}`);
      judgements[fingerprint] = { at: today, ...record };
    }
    await save(name, judgements);
    console.log(`${name}: ${Object.keys(records).length} judgement(s)`);
  }
} else if (command) {
  // A queue of what still needs a verdict, with everything needed to decide.
  const dir = runDir(command);
  const scans = await readRun(dir);
  const run = await scoreRun(scans, await loadBenchmarks());
  const only = new Set(rest);
  const sections: string[] = [];
  let count = 0;
  for (const [name, list] of [...run.scores, ...run.targets.map((t) => [t.name, [t]] as const)]) {
    if (only.size && !only.has(name)) continue;
    const seen = new Set<string>();
    list.forEach((scored, i) => {
      const report = scans.scans.get(name)![i]!;
      scored.findings.forEach((f, j) => {
        if (f.outcome !== "unjudged" || (!values.all && !f.shown) || seen.has(f.fingerprint)) return;
        seen.add(f.fingerprint);
        count++;
        sections.push(describe(name, report.findings[j]!));
      });
    });
  }
  const out = join(dir, "judge.md");
  await writeFile(
    out,
    `# Findings to judge (${count})\n\nFor each: read the code at the benchmark's commit, then\n\`bun run judge set <benchmark> <fingerprint> real|false_positive|not_security|test_code|duplicate [--dup <fp>] [--severity <s>] [--note "…"]\`\n\n${sections.join("\n\n---\n\n")}\n`,
  );
  console.log(`${count} finding(s) to judge: ${out}`);
} else {
  console.error("Usage: bun run judge <run> [benchmark…] [--all] | set … | apply <file.json>");
  process.exit(2);
}

function describe(name: string, f: Finding): string {
  const path = f.attackPath.map((s) => `  - \`${s.file}:${s.line}\` ${s.note}`).join("\n");
  return [
    `## [${name}] ${f.fingerprint}: ${f.title}`,
    `${f.severity}/${f.confidence} · ${f.category}${f.cwe ? ` (${f.cwe})` : ""} · attacker: ${f.attacker} · trust: ${f.trust ?? "—"}`,
    `Entry: \`${f.entryPoint.file}:${f.entryPoint.line}\` ${f.entryPoint.description}`,
    `Path:\n${path}`,
    `Preconditions: ${f.preconditions}`,
    `Impact: ${f.impact}`,
    f.mitigations ? `Mitigations: ${f.mitigations}` : "",
    `PoC:\n\n\`\`\`\n${f.proofOfConcept}\n\`\`\``,
    `Skeptic (${f.skeptic.confidence}): ${f.skeptic.reasoning}`,
  ]
    .filter(Boolean)
    .join("\n");
}
