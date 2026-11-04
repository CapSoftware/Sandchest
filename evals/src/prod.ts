/**
 * Quality in production, from the read replica: the numbers benchmarks can't
 * give (real repositories, real teams). Prints counts and rates only, and
 * appends them to prod-history.jsonl in the eval data, so the trend survives.
 *
 *   SANDCHEST_ANALYSIS_URL=postgres://… bun run prod [--since 2026-11-01]
 *
 * Use the read-only analysis role on the replica; the script refuses a
 * session that can write. Finding text is read only to spot duplicates in
 * memory, and never printed or saved. Labels from reviewers live in the eval
 * data's labels/prod.json, keyed by finding id.
 */
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SQL } from "bun";
import { DATA_DIR, LABELS_DIR, requireData } from "./data";
import { isTestPath, ratio, type JudgementRecord } from "./score";

const { values } = parseArgs({ options: { since: { type: "string", default: "2000-01-01" } } });
requireData();
const url = process.env.SANDCHEST_ANALYSIS_URL;
if (!url) throw new Error("Set SANDCHEST_ANALYSIS_URL to the read-only analysis role on the replica.");
const sql = new SQL({ url, max: 2, connection: { default_transaction_read_only: "on", statement_timeout: "60000", application_name: "sandchest-evals" } });
const [session] = await sql<{ ro: string }[]>`select current_setting('transaction_read_only') ro`;
if (session?.ro !== "on") throw new Error("The session can write. Use the read-only analysis role.");

interface Row {
  id: string;
  repo_id: string;
  severity: string;
  confidence: string;
  category: string;
  status: string;
  dismiss_reason: string | null;
  title: string;
  entry_point: { file: string };
  attack_path: Array<{ file: string }>;
  source_kind: string;
  source_scan_id: string | null;
  fixed_by: "fix_check" | "person" | null;
  single_copy: boolean;
}

const since = values.since!;
const findings = await sql<Row[]>`
  select f.id, f.repo_id, f.severity, f.confidence, f.category, f.status, f.dismiss_reason, f.title, f.entry_point, f.attack_path, f.source_kind, f.source_scan_id,
    (select case when e.user_id is null then 'fix_check' else 'person' end from finding_events e where e.finding_id = f.id and e.type = 'fixed' order by e.created_at desc limit 1) fixed_by,
    exists (
      select 1 from finding_events e where e.finding_id = f.id and e.type = 'prompt_copied'
        and (select count(*) from finding_events o where o.user_id = e.user_id and o.type = 'prompt_copied' and date_trunc('second', o.created_at) = date_trunc('second', e.created_at)) = 1
    ) single_copy
  from findings f where f.first_seen_at >= ${since}::timestamptz`;
const [deep] = await sql<{ scans: number; candidates: number; survivors: number; median_ms: number; loc_lt_50k_cost: number; loc_gt_200k_cost: number }[]>`
  select count(*)::int scans, coalesce(sum(m.candidates), 0)::int candidates, coalesce(sum(m.survivors), 0)::int survivors,
    percentile_cont(0.5) within group (order by m.duration_ms) median_ms,
    avg(m.model_cost_usd) filter (where r.loc < 50000)::float loc_lt_50k_cost, avg(m.model_cost_usd) filter (where r.loc > 200000)::float loc_gt_200k_cost
  from scans s join scan_metrics m on m.scan_id = s.id join repos r on r.id = s.repo_id
  where s.kind = 'deep' and s.status = 'completed' and s.created_at >= ${since}::timestamptz`;
// Rescans: of the findings a later deep scan of the same repo reported, how many it matched to an existing finding.
const [rescan] = await sql<{ scans: number; reseen: number; fresh: number }[]>`
  with ranked as (select s.id, s.repo_id, row_number() over (partition by s.repo_id order by s.created_at) n from scans s where s.kind = 'deep' and s.status = 'completed' and s.created_at >= ${since}::timestamptz)
  select count(*)::int scans,
    coalesce(sum((select count(*) from finding_events e join findings f on f.id = e.finding_id where e.scan_id = r.id and e.type = 'seen' and f.source_scan_id <> r.id)), 0)::int reseen,
    coalesce(sum((select count(*) from findings f where f.source_scan_id = r.id)), 0)::int fresh
  from ranked r where r.n > 1`;
const refusedFixChecks = (await sql<{ n: number }[]>`select count(*)::int n from scans where kind = 'fix_check' and status = 'refused' and created_at >= ${since}::timestamptz`)[0]!.n;
await sql.close();

const labelsFile = join(LABELS_DIR, "prod.json");
const labels = existsSync(labelsFile) ? (JSON.parse(await readFile(labelsFile, "utf8")) as Record<string, JudgementRecord>) : {};

const serious = (f: Row) => f.severity === "critical" || f.severity === "high";
const count = (list: Row[], test: (f: Row) => boolean) => list.filter(test).length;
const tiers: Array<[string, (f: Row) => boolean]> = [
  ["critical/high", serious],
  ["medium/low", (f) => !serious(f)],
  ["all", () => true],
];

const STOP = new Set("the a an of to in and or for via on with by any can lets let is are be from into without no not that their its it as at user users".split(" "));
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9_/.]+/g, " ").split(" ").filter((t) => t.length > 2 && !STOP.has(t)));
const files = (f: Row) => new Set([f.entry_point?.file, ...(f.attack_path ?? []).map((s) => s.file)].filter(Boolean));
const jaccard = (a: Set<string>, b: Set<string>) => {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared || 1);
};
/** Likely the same bug: same class family and overlapping citations and title, or near-identical titles. */
function likelyDuplicates(list: Row[]): number {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    return p === x ? x : find(p);
  };
  const byRepo = new Map<string, Row[]>();
  for (const f of list) byRepo.set(f.repo_id, [...(byRepo.get(f.repo_id) ?? []), f]);
  for (const group of byRepo.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        const titles = jaccard(words(a.title), words(b.title));
        if ((a.category === b.category && jaccard(files(a), files(b)) >= 0.34 && titles >= 0.25) || titles >= 0.5) parent.set(find(a.id), find(b.id));
      }
    }
  }
  return list.length - new Set(list.map((f) => find(f.id))).size;
}

const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
console.log(`Production findings since ${since}: ${findings.length}\n`);
const header = ["", "findings", "fixed (check)", "fixed (person)", "dismissed FP", "other dismiss", "single copy", "labelled", "labelled real", "test code", "dup (est.)"];
const table = [header];
const metrics: Record<string, unknown> = { at: new Date().toISOString(), since, findings: findings.length };
for (const [name, test] of tiers) {
  const list = findings.filter(test);
  const labelled = list.filter((f) => labels[f.id]);
  const judged = labelled.filter((f) => ["real", "false_positive", "not_security"].includes(labels[f.id]!.verdict));
  const real = count(judged, (f) => labels[f.id]!.verdict === "real");
  const row = {
    findings: list.length,
    fixedByCheck: count(list, (f) => f.fixed_by === "fix_check"),
    fixedByPerson: count(list, (f) => f.fixed_by === "person"),
    dismissedFp: count(list, (f) => f.dismiss_reason === "false_positive"),
    dismissedOther: count(list, (f) => f.status === "dismissed" && f.dismiss_reason !== "false_positive"),
    singleCopy: count(list, (f) => f.single_copy),
    labelled: labelled.length,
    labelledPrecision: ratio(real, judged.length),
    testCode: count(list, (f) => [f.entry_point, ...(f.attack_path ?? [])].every((s) => s?.file && isTestPath(s.file))),
    duplicates: likelyDuplicates(list),
  };
  metrics[name] = row;
  table.push([name, ...[row.findings, row.fixedByCheck, row.fixedByPerson, row.dismissedFp, row.dismissedOther, row.singleCopy, row.labelled].map(String), `${pct(row.labelledPrecision)} of ${judged.length}`, String(row.testCode), String(row.duplicates)]);
}
const widths = header.map((_, i) => Math.max(...table.map((r) => r[i]!.length)));
console.log(table.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ")).join("\n"));

const labelledAll = findings.filter((f) => labels[f.id]);
const severityDiffs = labelledAll.filter((f) => labels[f.id]!.severity && labels[f.id]!.severity !== f.severity);
const rank = ["critical", "high", "medium", "low"];
const over = severityDiffs.filter((f) => rank.indexOf(labels[f.id]!.severity!) > rank.indexOf(f.severity)).length;
const byCategory = new Map<string, { n: number; real: number; judged: number }>();
for (const f of labelledAll) {
  const c = byCategory.get(f.category) ?? { n: 0, real: 0, judged: 0 };
  c.n++;
  const v = labels[f.id]!.verdict;
  if (["real", "false_positive", "not_security"].includes(v)) c.judged++;
  if (v === "real") c.real++;
  byCategory.set(f.category, c);
}
const rescanMatch = ratio(rescan!.reseen, rescan!.reseen + rescan!.fresh);
const skepticRemoved = ratio(deep!.candidates - deep!.survivors, deep!.candidates);
console.log(`
Deep scans: ${deep!.scans}; skeptic removed ${pct(skepticRemoved)} of ${deep!.candidates} candidates; median ${(deep!.median_ms / 60_000).toFixed(1)} min.
Cost per deep scan: ${deep!.loc_lt_50k_cost?.toFixed(2) ?? "—"} USD under 50k LOC, ${deep!.loc_gt_200k_cost?.toFixed(2) ?? "—"} USD over 200k LOC (same budget whatever the size).
Rescans (${rescan!.scans}): ${pct(rescanMatch)} of what they reported matched an existing finding; the rest were filed as new.
Labelled findings with a different severity: ${severityDiffs.length} of ${labelledAll.length} (${over} over-rated by the scanner, ${severityDiffs.length - over} under-rated).
Fix checks refused for billing: ${refusedFixChecks} (each is a lost "was it real?" signal).`);
if (byCategory.size) {
  console.log("\nLabelled precision by category:");
  for (const [category, c] of [...byCategory].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${category.padEnd(26)} ${String(c.real).padStart(3)}/${String(c.judged).padEnd(3)} real  ${pct(ratio(c.real, c.judged))}`);
}
Object.assign(metrics, { deep, rescanMatch, skepticRemoved, refusedFixChecks, severityDiffs: severityDiffs.length, overRated: over });
await appendFile(join(DATA_DIR, "prod-history.jsonl"), `${JSON.stringify(metrics)}\n`);
