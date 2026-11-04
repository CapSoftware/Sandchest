/**
 * How accurately a push closes findings. Each known bug with a known fix is
 * stored the way a scan stores it (cited lines with excerpts from the
 * vulnerable code), then put through the production fix check twice:
 * - on the fixed code, as the push that fixed it: it should close (`fixed`);
 * - on the vulnerable code, as a push that touched the file without fixing
 *   it: it must stay open. Closing here is a false fix, the costly mistake (a
 *   real bug disappears from the dashboard).
 * - on the vulnerable code with a harmless edit next to the sink (a comment),
 *   as a push that changed the cited file without fixing it: must stay open.
 * Each check is shown the push's diff, as in production: the fix's own diff
 * from GitHub for public pairs, a local diff otherwise.
 * A push only re-checks findings that cite a file it changed, so a fix made
 * elsewhere (a guard in middleware, a version bump in a lockfile) is never
 * looked at: reported as "not triggered".
 *
 *   bun run fixeval [name|tag…] [--repeat 2] [--pairs <file.json>] [--summary <file>]
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createLlmClient, loadLlmConfig, startLocalIndexer } from "@sandchest/engine";
import { checkFixes, loadPricing, type ChangedFile, type Finding, type FixCheckResult } from "@sandchest/engine/scan";
import { DATA_DIR, requireData } from "./data";
import { loadPairs, type Pair } from "./pairs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { repeat: { type: "string", default: "2" }, pairs: { type: "string" }, summary: { type: "string" }, parallel: { type: "string", default: "6" } },
});

requireData();
const pairs = await loadPairs(positionals, values.pairs);
const repeat = Math.max(1, Math.floor(Number(values.repeat)) || 1);
const client = createLlmClient(loadLlmConfig());
const pricing = loadPricing();
let cost = 0;

/** Lines `line-1..line+1` of a file, numbered as scans store them. */
async function excerpt(dir: string, file: string, line: number): Promise<string> {
  const lines = (await readFile(join(dir, file), "utf8").catch(() => "")).split("\n");
  const from = Math.max(1, line - 1);
  const to = Math.min(lines.length, line + 1);
  const width = String(to).length;
  return Array.from({ length: to - from + 1 }, (_, i) => `${String(from + i).padStart(width)}| ${lines[from - 1 + i] ?? ""}`).join("\n");
}

/** The bug as a stored finding, with excerpts read from the vulnerable code. */
async function storedFinding(pair: Pair): Promise<Finding & { id: string }> {
  const c = pair.candidate;
  const attackPath = await Promise.all(c.path.map(async (step) => ({ ...step, excerpt: await excerpt(pair.vulnerableDir, step.file, step.line) })));
  return {
    id: pair.name,
    fingerprint: pair.name,
    title: c.title,
    severity: c.severity,
    confidence: "high",
    category: c.category,
    cwe: null,
    impact: c.impact,
    mitigations: "",
    entryPoint: c.entryPoint,
    attackPath,
    attacker: c.preconditions.attacker,
    preconditions: c.preconditions.trigger,
    proofOfConcept: c.proofOfConcept,
    fixGuidance: "",
    guarantees: [],
    mustNotBreak: [],
    regressionTest: "",
    fixPrompt: "",
    leads: [],
    skeptic: { confidence: "high", reasoning: "" },
    sources: ["hunter"],
  };
}

/** Whether a push from the vulnerable to the patched code changes a file the finding cites (what triggers a re-check). */
async function triggered(pair: Pair, finding: Finding): Promise<boolean> {
  const files = [...new Set([finding.entryPoint.file, ...finding.attackPath.map((s) => s.file)])];
  for (const file of files) {
    const [a, b] = await Promise.all([readFile(join(pair.vulnerableDir, file), "utf8").catch(() => null), readFile(join(pair.patchedDir, file), "utf8").catch(() => null)]);
    if (a !== b) return true;
  }
  return false;
}

const COMPARE_CACHE = join(DATA_DIR, "cache", "compare");

/** The fix's diff as a push delivers it: GitHub's compare of the two commits (cached), else a local diff of the cited files. */
async function fixChanges(pair: Pair, finding: Finding): Promise<ChangedFile[]> {
  if (pair.github) {
    const { repo, base, head } = pair.github;
    const file = join(COMPARE_CACHE, `${repo.replace("/", "__")}-${base.slice(0, 12)}-${head.slice(0, 12)}.json`);
    if (!existsSync(file)) {
      const proc = Bun.spawn(["gh", "api", `repos/${repo}/compare/${base}...${head}`, "--jq", "[.files[] | {filename, status, additions, deletions, patch}]"], { stdout: "pipe", stderr: "pipe" });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (code !== 0) throw new Error(`gh compare failed for ${repo}`);
      await mkdir(COMPARE_CACHE, { recursive: true });
      await writeFile(file, out);
    }
    const files = JSON.parse(await readFile(file, "utf8")) as Array<{ filename: string; status: ChangedFile["status"]; additions: number; deletions: number; patch?: string }>;
    return files.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, hunks: [], patch: f.patch }));
  }
  const files = [...new Set([finding.entryPoint.file, ...finding.attackPath.map((s) => s.file)])];
  const out: ChangedFile[] = [];
  for (const file of files) {
    const patch = await localDiff(join(pair.vulnerableDir, file), join(pair.patchedDir, file));
    if (patch) out.push({ path: file, status: "modified", additions: 0, deletions: 0, hunks: [], patch });
  }
  return out;
}

/** `git diff --no-index` of two files, hunks only (the header names temp paths). */
async function localDiff(a: string, b: string): Promise<string | undefined> {
  const proc = Bun.spawn(["git", "diff", "--no-index", "--unified=3", a, b], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const at = out.indexOf("\n@@");
  return at < 0 ? undefined : out.slice(at + 1);
}

/**
 * A copy of the vulnerable code (copy-on-write) with a harmless comment added
 * above the sink: a push that touches the cited file without fixing anything.
 */
async function harmlessEdit(pair: Pair, finding: Finding): Promise<{ dir: string; changes: ChangedFile[] }> {
  const dir = await mkdtemp(join(tmpdir(), "sc-fixeval-"));
  const proc = Bun.spawn(["cp", "-cR", `${pair.vulnerableDir}/.`, dir], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error("copy failed");
  const sink = finding.attackPath.at(-1)!;
  const path = join(dir, sink.file);
  const lines = (await readFile(path, "utf8")).split("\n");
  const indent = /^\s*/.exec(lines[sink.line - 1] ?? "")![0];
  const comment = /\.(py|rb|sh|ya?ml|toml|ex|exs|pl)$/.test(sink.file) ? "#" : "//";
  lines.splice(sink.line - 1, 0, `${indent}${comment} Keep this in step with the other handlers.`);
  await writeFile(path, lines.join("\n"));
  const patch = await localDiff(join(pair.vulnerableDir, sink.file), path);
  return { dir, changes: [{ path: sink.file, status: "modified", additions: 1, deletions: 0, hunks: [], patch }] };
}

async function outcomes(dir: string, pair: Pair, finding: Finding & { id: string }, changes?: ChangedFile[]): Promise<FixCheckResult[]> {
  await using indexer = await startLocalIndexer(dir);
  const out: FixCheckResult[] = [];
  for (let run = 0; run < repeat; run++) {
    const { results, costUsd } = await checkFixes({ client, indexer: indexer.client, threatModel: pair.threatModel, findings: [finding], changes, pricing });
    cost += costUsd ?? 0;
    out.push(results[0]!);
  }
  return out;
}

interface Row {
  name: string;
  partialFix: boolean;
  triggered: boolean;
  /** Outcomes on the fixed code (want "fixed"). */
  onFix: FixCheckResult["outcome"][];
  /** Outcomes on the vulnerable code (want "open"). */
  onVulnerable: FixCheckResult["outcome"][];
  /** Outcomes on the vulnerable code with a harmless edit to the cited file (want "open"). */
  onEdit: FixCheckResult["outcome"][];
  reasons: string[];
}

const rows: Row[] = [];
const queue = [...pairs];
await Promise.all(
  Array.from({ length: Math.max(1, Number(values.parallel) || 1) }, async () => {
    for (let pair = queue.shift(); pair; pair = queue.shift()) {
      try {
        const finding = await storedFinding(pair);
        const [changes, edit] = await Promise.all([fixChanges(pair, finding), harmlessEdit(pair, finding)]);
        const [fire, onFix, onVulnerable, onEdit] = await Promise.all([
          triggered(pair, finding),
          outcomes(pair.patchedDir, pair, finding, changes),
          outcomes(pair.vulnerableDir, pair, finding),
          outcomes(edit.dir, pair, finding, edit.changes),
        ]);
        Bun.spawn(["trash", edit.dir]);
        rows.push({
          name: pair.name,
          partialFix: !!pair.partialFix,
          triggered: fire,
          onFix: onFix.map((r) => r.outcome),
          onVulnerable: onVulnerable.map((r) => r.outcome),
          onEdit: onEdit.map((r) => r.outcome),
          reasons: [...onFix, ...onVulnerable, ...onEdit].map((r) => `${r.outcome}: ${r.reason.replace(/\s+/g, " ").slice(0, 240)}`),
        });
      } catch (error) {
        console.error(`${pair.name}: ${(error as Error).message}`);
      }
    }
  }),
);
rows.sort((a, b) => a.name.localeCompare(b.name));

const share = (xs: string[], want: string) => (xs.length ? xs.filter((x) => x === want).length / xs.length : 0);
const pct = (x: number) => `${Math.round(100 * x)}%`;
const width = Math.max(30, ...rows.map((r) => r.name.length + 1));
console.log(`${"pair".padEnd(width)} push touches it  on fix → fixed  unchanged → fixed  harmless edit → fixed`);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(width)} ${(r.triggered ? "yes" : "NO").padStart(15)}  ${pct(share(r.onFix, "fixed")).padStart(13)}  ${pct(share(r.onVulnerable, "fixed")).padStart(15)}  ${pct(share(r.onEdit, "fixed")).padStart(19)}  ${r.onFix.join(",")} | ${r.onVulnerable.join(",")} | ${r.onEdit.join(",")}${r.partialFix ? "  (partial fix)" : ""}`,
  );
}

const clean = rows.filter((r) => !r.partialFix);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
// End to end: a fix closes the finding only if the push touches a cited file AND the check rules it fixed.
const closed = mean(clean.map((r) => (r.triggered ? share(r.onFix, "fixed") : 0)));
const ruledFixed = mean(clean.map((r) => share(r.onFix, "fixed")));
const falseFix = mean(rows.map((r) => share(r.onVulnerable, "fixed")));
const falseFixEdit = mean(rows.map((r) => share(r.onEdit, "fixed")));
const stale = mean(rows.flatMap((r) => [share(r.onFix, "stale"), share(r.onVulnerable, "stale"), share(r.onEdit, "stale")]));
const trigger = clean.filter((r) => r.triggered).length;
console.log(`\nPairs: ${rows.length} (${clean.length} clean fixes), repeat ${repeat}`);
console.log(`Fix push touches a cited file (re-check runs): ${trigger}/${clean.length}`);
console.log(`Re-check rules the fixed code fixed:            ${pct(ruledFixed)}`);
console.log(`Fixes closed automatically, end to end:         ${pct(closed)}  (want high)`);
console.log(`False fixes, code unchanged:                   ${pct(falseFix)}  (want 0)`);
console.log(`False fixes, harmless edit to the cited file:   ${pct(falseFixEdit)}  (want 0)`);
console.log(`Stale (cited code not found):                   ${pct(stale)}`);
console.log(`Cost: $${cost.toFixed(2)}`);
if (values.summary) await writeFile(values.summary, `${JSON.stringify({ pairs: rows.length, clean: clean.length, triggered: trigger, ruledFixed, closed, falseFix, falseFixEdit, stale, costUsd: cost, rows })}\n`);
