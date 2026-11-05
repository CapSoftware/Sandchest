/**
 * What a general coding-agent harness finds, against our hunters, on the same
 * benchmarks and judged the same way. opencode runs headless in each
 * benchmark's checkout with the scan model and its own built-in tools (read,
 * grep, glob, list; shell, edits and the web denied: this runs on a laptop),
 * in four focused passes (as a scan splits work across hunters), and returns
 * findings in our candidate shape. Those go through the engine's
 * evidence gate and skeptic exactly as a hunter's would, and are scored like
 * a scan.
 *
 *   bun run harness [name|tag…] [--minutes 15] [--parallel 3]
 *
 * opencode runs with its own empty config home: no personal config, plugins
 * or MCP servers reach it.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createLlmClient, loadLlmConfig, startLocalIndexer } from "@sandchest/engine";
import { CandidateSchema, huntSystemPrompt, loadPricing, verifyFindings, type Candidate, type Finding, type ScanReport } from "@sandchest/engine/scan";
import { loadBenchmarks, select } from "./benchmark";
import { checkout } from "./checkout";
import { DATA_DIR, requireData } from "./data";
import { UNKNOWN_APP } from "./pairs";
import { loadJudgements } from "./runs";
import { score } from "./score";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { minutes: { type: "string", default: "15" }, parallel: { type: "string", default: "3" } },
});
requireData();
const llm = loadLlmConfig();
const client = createLlmClient(llm);
const pricing = loadPricing();
const model = process.env.LLM_MODEL!;

/** An isolated opencode home: the scan model as an OpenAI-compatible provider, and read-only tools. */
async function opencodeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "sc-opencode-"));
  await mkdir(join(home, "opencode"), { recursive: true });
  const config = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    provider: { scan: { npm: "@ai-sdk/openai-compatible", name: "scan", options: { baseURL: process.env.LLM_BASE_URL, apiKey: "{env:LLM_API_KEY}" }, models: { [model]: { name: model } } } },
    permission: { edit: "deny", bash: "deny", webfetch: "deny", external_directory: "deny" },
  };
  await writeFile(join(home, "opencode", "opencode.json"), JSON.stringify(config, null, 2));
  return home;
}

const OUTPUT = `## Tools here
You have read, grep, glob and list over the repository in your working directory, and nothing else: no shell, no edits, no network. There is no index: find entry points, sinks and guards with grep and glob, then read the code.

## What to return
Hunt the whole application. When you are done, reply with only a JSON array (in a \`\`\`json block) of every vulnerability you found, each:
{"title": string, "category": one of ${JSON.stringify(["sql_injection", "nosql_injection", "command_injection", "code_injection", "template_injection", "path_traversal", "ssrf", "xss", "xxe", "insecure_deserialization", "broken_access_control", "broken_authentication", "privilege_escalation", "mass_assignment", "open_redirect", "hardcoded_secret", "weak_cryptography", "sensitive_data_exposure", "vulnerable_dependency", "prototype_pollution", "csrf", "unrestricted_file_upload", "denial_of_service", "business_logic", "race_condition", "resource_abuse", "prompt_injection", "other"])},
 "severity": "critical" | "high" | "medium" | "low",
 "entryPoint": {"file": repo-relative path, "line": number, "description": string},
 "path": [{"file": string, "line": number, "note": string}] (the hops you read, input to sink, at least one),
 "preconditions": {"attacker": "unauthenticated" | "any_user" | "insider" | "admin", "trigger": what the attacker sends, "details": string},
 "proofOfConcept": string, "impact": string}
Cite only lines you have read. An empty array is fine when you found nothing.`;

/** Passes per benchmark, as our scan splits the work across hunters; their findings are pooled before review. */
const FOCUS = [
  "Your focus: authentication and authorisation across every entry point. List the routes and handlers first (grep for the framework's routing), then check each one: who can call it, and whether it checks that the caller may act on the specific object it reads or changes. Compare sibling routes.",
  "Your focus: injection and dangerous sinks: SQL and NoSQL queries, shell commands, eval, templates, file paths, outbound requests (SSRF), deserialisation, XML. Find each sink with grep, then trace attacker input back to it.",
  "Your focus: business logic and abuse: payments, credits, quotas, invites, roles and settings a user should not change, races, and expensive work an attacker can force.",
  "Your focus: login, sessions, tokens, password reset, OAuth and SSO flows, account linking, and secrets in the code.",
];

/** The hunter's brief, with opencode's tools in place of the index and a JSON reply in place of report_finding. */
function prompt(focus: string): string {
  return huntSystemPrompt("untrusted")
    .replace(/- Use the index:[^\n]*\n/, "")
    .replace(/- When the attack hinges on how a dependency behaves[^\n]*\n/, "")
    .replace(/## What to report\n[\s\S]*?(?=## Severity)/, "")
    .concat(`\n\n${focus}\n\nBe thorough: cover your whole focus area before you answer, however many steps it takes.\n\n${OUTPUT}`);
}

interface Usage { input: number; output: number; cached: number }

async function runOpencode(dir: string, home: string, focus: string): Promise<{ text: string; usage: Usage; ms: number }> {
  const started = Date.now();
  const proc = Bun.spawn(["opencode", "run", "--pure", "--format", "json", "--dir", dir, "-m", `scan/${model}`, prompt(focus)], {
    env: { ...process.env, XDG_CONFIG_HOME: home, XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"), OPENCODE_DISABLE_AUTOUPDATE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), Number(values.minutes) * 60_000);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  await writeFile(join(home, "..", `${home.split("/").pop()}.events.jsonl`), out + (err ? `\n#stderr\n${err}` : ""));
  clearTimeout(timer);
  const usage: Usage = { input: 0, output: 0, cached: 0 };
  const texts: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let event: { type?: string; part?: { type?: string; text?: string; tokens?: { input?: number; output?: number; cache?: { read?: number } } } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.part?.type === "text" && event.part.text) texts.push(event.part.text);
    const tokens = event.part?.tokens;
    if (event.part?.type === "step-finish" && tokens) {
      usage.input += tokens.input ?? 0;
      usage.output += tokens.output ?? 0;
      usage.cached += tokens.cache?.read ?? 0;
    }
  }
  return { text: texts.join("\n"), usage, ms: Date.now() - started };
}

/** The candidates in the reply's JSON block (or its last JSON array), each checked against our schema. */
function candidatesOf(text: string): Candidate[] {
  const block = /```json\s*([\s\S]*?)```/g;
  let raw: string | undefined;
  for (let m = block.exec(text); m; m = block.exec(text)) raw = m[1];
  raw ??= text.slice(text.lastIndexOf("["), text.lastIndexOf("]") + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? parsed : []).flatMap((item) => {
    const result = CandidateSchema.safeParse(item);
    return result.success ? [result.data] : [];
  });
}

function asFinding(candidate: Candidate, severity: Finding["severity"], confidence: Finding["confidence"]): Finding {
  return {
    fingerprint: `${candidate.category}:${candidate.path.at(-1)?.file}:${candidate.path.at(-1)?.line}`,
    title: candidate.title,
    severity,
    confidence,
    category: candidate.category,
    cwe: null,
    impact: candidate.impact,
    mitigations: "",
    entryPoint: candidate.entryPoint,
    attackPath: candidate.path.map((step) => ({ ...step, excerpt: "" })),
    attacker: candidate.preconditions.attacker,
    preconditions: candidate.preconditions.details,
    proofOfConcept: candidate.proofOfConcept,
    fixGuidance: "",
    guarantees: [],
    mustNotBreak: [],
    regressionTest: "",
    fixPrompt: "",
    leads: [],
    skeptic: { confidence, reasoning: "" },
    sources: ["harness"],
  };
}

const benchmarks = select(await loadBenchmarks(), positionals.length ? positionals : ["cve"]).filter((b) => b.kind === "vulnerable");
const out = join(DATA_DIR, "harness", new Date().toISOString().replace(/[:.]/g, "-"));
await mkdir(out, { recursive: true });
const rows: Array<{ name: string; candidates: number; shown: number; serious: number; found: number; tp: number; fp: number; unjudged: number; minutes: number; costUsd: number }> = [];
const queue = [...benchmarks];
await Promise.all(
  Array.from({ length: Math.max(1, Number(values.parallel) || 1) }, async () => {
    for (let benchmark = queue.shift(); benchmark; benchmark = queue.shift()) {
      try {
        const dir = await checkout(benchmark);
        const passes = await Promise.all(
          FOCUS.map(async (focus) => {
            const home = await opencodeHome();
            const pass = await runOpencode(dir, home, focus);
            Bun.spawn(["trash", home]);
            return pass;
          }),
        );
        const run = {
          usage: passes.reduce((u, p) => ({ input: u.input + p.usage.input, output: u.output + p.usage.output, cached: u.cached + p.usage.cached }), { input: 0, output: 0, cached: 0 }),
          ms: Math.max(...passes.map((p) => p.ms)),
        };
        const candidates = passes.flatMap((p) => candidatesOf(p.text));
        await using indexer = await startLocalIndexer(dir);
        const verified = await verifyFindings({ client, indexer: indexer.client, threatModel: UNKNOWN_APP, findings: candidates, pricing });
        const findings = verified.results.flatMap((r) => (r.review?.verdict.verdict === "confirmed" ? [asFinding(r.candidate, r.review.verdict.severity, r.review.verdict.confidence)] : []));
        const report = { findings, dismissed: [], threatModel: UNKNOWN_APP } as unknown as ScanReport;
        const scored = score(benchmark, report, await loadJudgements(benchmark.name));
        const harnessCost = pricing ? (run.usage.input * pricing.input + run.usage.cached * pricing.cachedInput + run.usage.output * pricing.output) / 1_000_000 : 0;
        const costUsd = harnessCost + (verified.costUsd ?? 0);
        await writeFile(join(out, `${benchmark.name}.json`), `${JSON.stringify({ candidates, findings, usage: run.usage, ms: run.ms, costUsd }, null, 2)}\n`);
        rows.push({ name: benchmark.name, candidates: candidates.length, shown: scored.shown.total, serious: scored.expected.serious, found: scored.found.serious, tp: scored.shown.truePositives, fp: scored.shown.falsePositives, unjudged: scored.shown.unjudged, minutes: run.ms / 60_000, costUsd });
        console.error(`[${benchmark.name}] ${candidates.length} candidates, ${findings.length} confirmed, ${scored.found.serious}/${scored.expected.serious} expected found, $${costUsd.toFixed(2)}, ${(run.ms / 60_000).toFixed(1)} min`);
      } catch (error) {
        console.error(`[${benchmark.name}] failed: ${(error as Error).message}`);
      }
    }
  }),
);
rows.sort((a, b) => a.name.localeCompare(b.name));
const sum = (k: keyof (typeof rows)[number]) => rows.reduce((n, r) => n + (r[k] as number), 0);
console.log(`${"benchmark".padEnd(40)} cand shown found  tp  fp unjudged   cost  min`);
for (const r of rows) console.log(`${r.name.padEnd(40)} ${String(r.candidates).padStart(4)} ${String(r.shown).padStart(5)} ${`${r.found}/${r.serious}`.padStart(5)} ${String(r.tp).padStart(3)} ${String(r.fp).padStart(3)} ${String(r.unjudged).padStart(8)} ${r.costUsd.toFixed(2).padStart(6)} ${r.minutes.toFixed(1).padStart(4)}`);
console.log(`\nRecall, critical+high: ${sum("found")}/${sum("serious")}. Shown ${sum("shown")} (judged real ${sum("tp")}, false ${sum("fp")}, unjudged ${sum("unjudged")}). Cost $${sum("costUsd").toFixed(2)} ($${(sum("costUsd") / Math.max(1, rows.length)).toFixed(2)}/benchmark). Details: ${out}`);
