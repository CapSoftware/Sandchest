/**
 * Replays labelled production findings through the current skeptic, on the
 * commit they were found at. The labels (labels/prod.json, by finding id)
 * say which were real, false positives or not a security issue, so this
 * measures what a skeptic or prompt change does on real code: how many real
 * findings it keeps, how many false ones it now drops, and whether its
 * severity agrees with the reviewer's.
 *
 *   SANDCHEST_ANALYSIS_URL=… GITHUB_TOKEN=… bun run replay:prod [--repeat N] [--ground]
 *
 * Finding text is read from the replica at run time and never written to the
 * eval data: the output keeps finding ids, labels and rates only. Private
 * repositories need GITHUB_TOKEN; only label repositories you own or that
 * are public.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SQL } from "bun";
import { createLlmClient, loadLlmConfig, startLocalIndexer } from "@sandchest/engine";
import { loadPricing, ThreatModelSchema, verifyFindings, type Finding, type ThreatModel } from "@sandchest/engine/scan";
import { checkoutAt } from "./checkout";
import { DATA_DIR, LABELS_DIR, requireData } from "./data";
import type { JudgementRecord } from "./score";

const { values } = parseArgs({ options: { repeat: { type: "string", default: "2" }, ground: { type: "boolean", default: false } } });
requireData();
const url = process.env.SANDCHEST_ANALYSIS_URL;
if (!url) throw new Error("Set SANDCHEST_ANALYSIS_URL to the read-only analysis role on the replica.");
const labelsFile = join(LABELS_DIR, "prod.json");
if (!existsSync(labelsFile)) throw new Error(`No ${labelsFile}.`);
const labels = JSON.parse(await readFile(labelsFile, "utf8")) as Record<string, JudgementRecord>;
const KEEP = new Set(["real"]);
const DROP = new Set(["false_positive", "not_security"]);
const ids = Object.keys(labels).filter((id) => KEEP.has(labels[id]!.verdict) || DROP.has(labels[id]!.verdict));

const sql = new SQL({ url, max: 2, connection: { default_transaction_read_only: "on", statement_timeout: "60000", application_name: "sandchest-evals" } });
const [session] = await sql<{ ro: string }[]>`select current_setting('transaction_read_only') ro`;
if (session?.ro !== "on") throw new Error("The session can write. Use the read-only analysis role.");
type Row = { id: string; repo: string; private: boolean; sha: string; threat_model: unknown; finding: Finding };
const rows: Row[] = await sql<Row[]>`
  select f.id, r.full_name repo, r.private, s.head_sha sha, m.threat_model,
    json_build_object('fingerprint', f.fingerprint, 'title', f.title, 'severity', f.severity, 'confidence', f.confidence, 'category', f.category, 'cwe', f.cwe,
      'impact', f.impact, 'entryPoint', f.entry_point, 'attackPath', f.attack_path, 'attacker', f.attacker, 'preconditions', f.preconditions,
      'proofOfConcept', f.proof_of_concept, 'leads', '[]'::json) finding
  from findings f join repos r on r.id = f.repo_id join scans s on s.id = f.source_scan_id left join repo_memory m on m.repo_id = f.repo_id
  where f.id = any(${ids}::uuid[])`;
await sql.close();

const UNKNOWN: ThreatModel = { summary: "A web application under review.", stack: [], entryPoints: [], authModel: "Unknown: read the code.", trustBoundaries: [], sensitiveAssets: [], dangerousSinks: [], frameworkProtections: [], abuseSurfaces: [], subsystems: [] } as unknown as ThreatModel;
const repeat = Math.max(1, Math.floor(Number(values.repeat)) || 1);
const client = createLlmClient(loadLlmConfig());
const pricing = loadPricing();
const token = process.env.GITHUB_TOKEN;
let cost = 0;

interface Result {
  id: string;
  label: string;
  keepRate: number;
  /** Severity the skeptic settled on in its last confirming run, against the reviewer's. */
  severity?: string;
  labelSeverity?: string;
  error?: string;
}
const results: Result[] = [];
const groups = new Map<string, Row[]>();
for (const row of rows) groups.set(`${row.repo}@${row.sha}`, [...(groups.get(`${row.repo}@${row.sha}`) ?? []), row]);

await Promise.all(
  [...groups.values()].map(async (group) => {
    const { repo, sha, private: isPrivate } = group[0]!;
    let dir: string;
    try {
      if (isPrivate && !token) throw new Error("private repository: set GITHUB_TOKEN");
      dir = await checkoutAt(`https://github.com/${repo}.git`, sha, `prod-${repo.replace("/", "__")}`, isPrivate ? token : undefined);
    } catch (error) {
      for (const row of group) results.push({ id: row.id, label: labels[row.id]!.verdict, keepRate: 0, error: (error as Error).message.slice(0, 120) });
      return;
    }
    const parsed = ThreatModelSchema.safeParse(group[0]!.threat_model);
    await using indexer = await startLocalIndexer(dir);
    const kept = new Array<number>(group.length).fill(0);
    const severities: Array<string | undefined> = [];
    for (let run = 0; run < repeat; run++) {
      const { results: verified, costUsd } = await verifyFindings({
        client,
        indexer: indexer.client,
        threatModel: parsed.success ? parsed.data : UNKNOWN,
        findings: group.map((row) => row.finding),
        pricing,
        investigateAuth: values.ground,
      });
      cost += costUsd ?? 0;
      verified.forEach((v, i) => {
        const verdict = v.review?.verdict;
        if (verdict?.verdict === "confirmed" && verdict.confidence !== "low") {
          kept[i]!++;
          severities[i] = verdict.severity;
        }
      });
    }
    group.forEach((row, i) => results.push({ id: row.id, label: labels[row.id]!.verdict, keepRate: kept[i]! / repeat, severity: severities[i], labelSeverity: labels[row.id]!.severity }));
  }),
);

const pct = (x: number) => `${Math.round(100 * x)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const ok = results.filter((r) => !r.error);
const real = ok.filter((r) => KEEP.has(r.label));
const wrong = ok.filter((r) => DROP.has(r.label));
const withSeverity = real.filter((r) => r.severity && r.labelSeverity);
console.log(`Replayed ${ok.length} labelled production findings × ${repeat}${values.ground ? " (auth-grounded)" : ""}; ${results.length - ok.length} skipped.`);
for (const r of results.filter((r) => r.error)) console.log(`  skipped ${r.id.slice(0, 8)}: ${r.error}`);
console.log(`Real (${real.length}): kept by majority ${pct(mean(real.map((r) => (r.keepRate > 0.5 ? 1 : 0))))}, mean keep-rate ${pct(mean(real.map((r) => r.keepRate)))} (want 100%)`);
console.log(`False positive or not security (${wrong.length}): dropped by majority ${pct(mean(wrong.map((r) => (r.keepRate > 0.5 ? 0 : 1))))}, mean keep-rate ${pct(mean(wrong.map((r) => r.keepRate)))} (want 0%)`);
console.log(`Skeptic severity matches the reviewer's on ${withSeverity.filter((r) => r.severity === r.labelSeverity).length}/${withSeverity.length} real findings.`);
console.log(`Cost: $${cost.toFixed(2)}`);
await mkdir(join(DATA_DIR, "replays"), { recursive: true });
const out = join(DATA_DIR, "replays", `prod-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(out, `${JSON.stringify(results, null, 2)}\n`);
console.log(`Details (ids and rates only): ${out}`);
