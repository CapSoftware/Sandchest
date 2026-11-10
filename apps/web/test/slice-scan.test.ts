/**
 * A deep scan on the slice engine, driven step by step in the workflow's order, against a real
 * Postgres (local docker). Fake: GitHub, the model, and the sandbox host (a sandbox with files, agent
 * sessions that finish a poll later, and sandboxes that can disappear). Skips without a local Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  createDb,
  createScan,
  eventsSince,
  finishUsageCall,
  scanById,
  scanStageRows,
  scanUsageRows,
  schema,
  startUsageCall,
  upsertInstallation,
  upsertRepos,
  type Db,
} from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { IndexerClient } from "@sandchest/engine/indexer";
import type { ChatRequest, ChatResult, LlmClient } from "@sandchest/engine/llm";
import { slice } from "@sandchest/engine/scan";
import type { GitHubApp } from "@sandchest/github";
import type { ExecResult } from "@sandchest/workspace";
import { setAutumn } from "@/server/billing";
import { resetConfig } from "@/server/config";
import { verifyGatewayToken } from "@/server/gateway";
import { stepOf, TRACKS } from "@/lib/scan-progress";
import { beginScan, failScan, ScanFinished } from "@/server/scans";
import { setServices } from "@/server/services";
import { SandboxGone, type SliceRuntime, type SliceSandbox } from "@/server/slice-runtime";
import { cleanUpSlice, collectSliceSession, huntSlice, publishSlice, sandboxKey, sliceSessionStatus, sliceState, startSliceSession, STOP_INDEXER, writeUpSlice, type SessionKind } from "@/server/slice-scan";
import { FakeAutumn } from "./fake-autumn";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgresql://sandchest:sandchest@127.0.0.1:5432/sandchest";
const NAME = `sandchest_slice_test_${process.pid}`;
const SECRET = "slice-test-gateway-secret-0123456789abcdef";
const ENV: Record<string, string> = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY: "unused",
  GITHUB_WEBHOOK_SECRET: "unused",
  SANDCHEST_APP_URL: "https://sandchest.test",
  SANDCHEST_WORKSPACE: "boat",
  SANDCHEST_BOAT_API_KEY: "boat_test_unused",
  SANDCHEST_INDEXER_LINUX_BIN: "/opt/sandchest-index",
  SANDCHEST_ENGINE: "slice",
  SANDCHEST_GATEWAY_SECRET: SECRET,
  SANDCHEST_SLICE_CEILING_USD: "0.5",
};

let admin: postgres.Sql | undefined;
let database: Db;
let available = true;
const saved: Record<string, string | undefined> = {};

// ---- The invented repository --------------------------------------------------

const FILE = [
  "export async function getProject(req) {",
  "  const id = req.params.id;",
  "  return db.projects.find(id);",
  "}",
  "// ...",
  "// ...",
  "// ...",
  "export async function deleteProject(req) {",
  "  const id = req.params.id;",
  "  return db.projects.delete(id);",
  "}",
  "// ...",
  "// ...",
  "// ...",
  "export async function renameProject(req) {",
  "  const name = req.body.name;",
  "  return db.projects.update(req.params.id, { name });",
  "}",
  "// ...",
  "// ...",
  "// ...",
  "export async function archiveProject(req) {",
  "  return db.projects.archive(req.params.id);",
  "}",
];
const PATH = "src/api/projects.ts";
const REPO: Record<string, string> = { [PATH]: `${FILE.join("\n")}\n`, "README.md": "acme/app\n" };
const LOC = 1_200;

function symbolAt(line: number): string | null {
  for (let i = line - 1; i >= 0; i--) {
    const m = FILE[i]!.match(/function (\w+)/);
    if (m) return m[1]!;
  }
  return null;
}

/** The indexer as the hunt and the write-up call it. */
function fakeIndexer(): IndexerClient {
  const tools: Record<string, (args: Record<string, unknown>) => unknown> = {
    overview: () => ({ loc: LOC }),
    routes: () => ({ routes: [] }),
    definitions: () => ({ definitions: [] }),
    deps: () => ({ dependencies: [] }),
    locate: (args) => ({
      locations: (args.locations as Array<{ file: string; line: number }>).map(({ file, line }) =>
        file === PATH && line <= FILE.length ? { file, line, exists: true, text: FILE[line - 1], symbol: symbolAt(line), totalLines: FILE.length } : { file, line, exists: false },
      ),
    }),
    read_file: (args) => {
      const start = Math.max(1, Number(args.startLine ?? 1));
      const end = Math.min(FILE.length, Number(args.endLine ?? FILE.length));
      return { path: args.path, startLine: start, endLine: end, totalLines: FILE.length, truncated: false, content: `${FILE.slice(start - 1, end).join("\n")}\n` };
    },
  };
  return {
    async ready() {},
    async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
      const handler = tools[tool];
      if (!handler) throw new Error(`unknown tool ${tool}`);
      return handler(args) as T;
    },
  };
}

// ---- The model ------------------------------------------------------------------

const model = {
  /** Cost reported on each call; undefined reports none. */
  costUsd: 0.001 as number | undefined,
  /** The hunt finds nothing. */
  empty: false,
  requests: [] as ChatRequest[],
};

const reply = (content: string): ChatResult => ({
  content,
  reasoning: "",
  toolCalls: [],
  finishReason: "stop",
  usage: { inputTokens: 100, cachedTokens: 20, outputTokens: 10, reasoningTokens: 0 },
  ...(model.costUsd !== undefined && { costUsd: model.costUsd }),
  message: { role: "assistant", content },
  retries: 0,
});
const contentOf = (r: ChatRequest) => String(r.messages[0]?.content ?? "");
const WRITE_UP = {
  severity: "high",
  cwe: "CWE-639",
  impact: "Reads other workspaces' projects.",
  mitigations: "",
  preconditions: "Any signed-in user.",
  proofOfConcept: "Request another workspace's project id while signed in.",
  fixGuidance: "Scope the lookup to the caller's workspace.",
  guarantees: ["Only the owner's workspace can reach the project"],
  mustNotBreak: ["Owners still reach their projects"],
  regressionTest: "Sign in as another workspace and assert 404.",
};

const fakeLlm: LlmClient = {
  config: { baseUrl: "http://fake", apiKey: "k", model: "m" },
  async chat(request) {
    model.requests.push(request);
    const name = request.responseFormat?.json_schema.name;
    if (name === "duplicate_groups") return reply(JSON.stringify({ groups: [] }));
    if (name === "severity_facts") return reply(JSON.stringify({ gain: "read_others_data", victimMustAct: false, unusualSetup: false }));
    if (name === "finding") {
      const id = request.messages.map((m) => String(m.content ?? "")).join("\n").match(/# Candidate (\S+):/)?.[1] ?? "?";
      return reply(JSON.stringify({ title: `Missing ownership check (${id})`, ...WRITE_UP }));
    }
    const content = contentOf(request);
    if (content.includes(slice.SCORE_TASK)) return reply([...content.matchAll(/^C(\d+)\|/gm)].map((m) => `C${m[1]}|7`).join("\n"));
    const entry = content.match(/^\[(E\d+)\] \S+ (\S+)/m);
    if (model.empty || !entry) return reply("NONE");
    return reply([`${entry[1]}|idor|a|${PATH}:3|other workspaces|project read without ownership check`, `${entry[1]}|sqli|a|${PATH}:17|all tenants|name reaches a raw query`].join("\n"));
  },
};

// ---- The sandbox host -------------------------------------------------------------

interface FakeSession {
  kind: slice.AgentSessionKind;
  findings: unknown[];
  token: string;
  polls: number;
  stopped: boolean;
  collected: number;
}

/** What each session does: finish after `polls` status reads, or fail; and which verdicts it writes. */
const host = {
  sandboxes: new Map<string, FakeSandbox>(),
  sessions: new Map<number, FakeSession>(),
  started: [] as Array<{ kind: slice.AgentSessionKind; sandboxId: string }>,
  outcome: { refute: "finish", variants: "finish" } as Record<slice.AgentSessionKind, "finish" | "fail" | "throw">,
  /** Verify: sinks ruled real. Variants: one sibling of the first confirmed finding. */
  realSinks: [`${PATH}:3`],
  /** The bulk read's pack command fails. */
  packFails: false,
  nextId: 1,
  nextProcess: 100,
  reset() {
    this.outcome = { refute: "finish", variants: "finish" };
    this.realSinks = [`${PATH}:3`];
    this.started = [];
    this.packFails = false;
  },
};

/** The bulk read's pack as the sandbox writes it: the wanted files of `REPO`, cut into parts. */
function pack(files: string[], partBytes: number): { parts: Buffer[]; summary: string } {
  const record = (kind: number, index: number, body = Buffer.alloc(0)) => {
    const h = Buffer.alloc(9);
    h[0] = kind;
    h.writeUInt32BE(index, 1);
    h.writeUInt32BE(body.length, 5);
    return Buffer.concat([h, body]);
  };
  const records = files.map((file, i) => (REPO[file] === undefined ? record(0, i) : record(1, i, Buffer.from(REPO[file]!))));
  const stream = Buffer.concat([Buffer.from("SCB1"), ...records, record(2, files.length)]);
  const parts: Buffer[] = [];
  for (let at = 0; at < stream.length; at += partBytes) parts.push(stream.subarray(at, at + partBytes));
  return { parts, summary: JSON.stringify({ parts: parts.length, records: files.length, bytes: stream.length }) };
}

class FakeSandbox implements SliceSandbox {
  readonly root = "/home/user/repo";
  readonly agentDir = "/home/user/agent";
  readonly privateFilesDir = "/home/user/.sandchest";
  readonly private = new Map<string, string>();
  readonly privateBytes = new Map<string, Buffer>();
  readonly execs: string[][] = [];
  /** Files read one call at a time. */
  readonly singleReads: string[] = [];
  destroyed = false;
  gone = false;
  indexerStarts = 0;
  ttl: number[] = [];
  /** When the current session's CLI ended, as its exit marker's time. */
  markerAt: number | undefined;

  constructor(readonly id: string) {}

  private check(): void {
    if (this.gone || this.destroyed) throw new Error("sandbox is gone");
  }
  async clone(): Promise<void> {
    this.check();
  }
  async exec(cmd: string[]): Promise<ExecResult> {
    this.check();
    this.execs.push(cmd);
    const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false, durationMs: 1 });
    if (cmd.join(" ") === "git rev-parse HEAD") return ok("0123456789abcdef0123456789abcdef01234567\n");
    if (cmd.join(" ") === "git ls-files -z") return ok(Object.keys(REPO).join("\0"));
    if (cmd[0] === "stat") return this.markerAt === undefined ? { ...ok(""), exitCode: 1 } : ok(`${Math.floor(this.markerAt / 1000)}\n`);
    if (cmd[0] === "node" && cmd[3] === "--") {
      if (host.packFails) return { ...ok(""), exitCode: 1 };
      // `node -e <packer> -- <list> <part prefix> ...`, both in the private directory; parts of 16 bytes here.
      const [list, prefix] = cmd.slice(4, 6).map((arg) => arg.slice(this.privateFilesDir.length + 1));
      const packed = pack(JSON.parse(this.private.get(list!)!) as string[], 16);
      packed.parts.forEach((part, n) => this.privateBytes.set(`${prefix}${n}`, part));
      return ok(packed.summary);
    }
    return ok("");
  }
  async startDetached(): Promise<void> {}
  async readFile(path: string): Promise<string> {
    this.check();
    this.singleReads.push(path);
    const text = REPO[path];
    if (text === undefined) throw new Error(`File not found: ${path}`);
    return text;
  }
  async installIndexer(): Promise<void> {}
  async startIndexer() {
    this.check();
    this.indexerStarts++;
    return { url: `https://${this.id}.boat.test`, token: crypto.randomUUID() };
  }
  async spawn(): Promise<{ processId: number }> {
    throw new Error("sessions are faked by the runtime");
  }
  process(): never {
    throw new Error("sessions are faked by the runtime");
  }
  async writeAgentFiles(): Promise<string[]> {
    return [];
  }
  async readAgentFile(): Promise<string> {
    return "";
  }
  async writePrivateFiles(files: Array<{ name: string; content: string }>): Promise<void> {
    this.check();
    for (const file of files) this.private.set(file.name, file.content);
  }
  async readPrivateFile(name: string): Promise<string | undefined> {
    this.check();
    return this.private.get(name);
  }
  async readPrivateBytes(name: string): Promise<Buffer | undefined> {
    this.check();
    return this.privateBytes.get(name);
  }
  async extendTtl(ttlSeconds: number): Promise<void> {
    this.check();
    this.ttl.push(ttlSeconds);
  }
  async usage() {
    this.check();
    return { seconds: 100, usd: 0.25, running: true };
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.destroy();
  }
}

const runtime: SliceRuntime = {
  async open({ ttlSeconds, setupScript }) {
    expect(ttlSeconds).toBe(90 * 60);
    expect(setupScript).toContain("LOOPBACK_PORTS='4100'");
    expect(setupScript).toContain("ALLOW_HOSTS=''");
    expect(setupScript).toContain("DNS='no'");
    const sandbox = new FakeSandbox(`bx_fake${String(host.nextId++).padStart(4, "0")}`);
    sandbox.ttl.push(ttlSeconds);
    host.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  },
  async attach(id) {
    const sandbox = host.sandboxes.get(id);
    if (!sandbox || sandbox.gone || sandbox.destroyed) throw new SandboxGone("The scan's sandbox is gone");
    return sandbox;
  },
  indexer: () => fakeIndexer(),
  async prepareAgentSandbox() {},
  async startAgentSession(sandbox, options) {
    if (host.outcome[options.kind] === "throw") throw new Error("Relay exited before it was ready");
    expect(options.relay.port).toBe(4100);
    expect(options.relay.targetUrl).toBe("https://sandchest.test/api/gateway");
    const relayProcessId = host.nextProcess++;
    const agentProcessId = host.nextProcess++;
    host.sessions.set(agentProcessId, { kind: options.kind, findings: options.findings, token: options.relay.token, polls: 0, stopped: false, collected: 0 });
    host.started.push({ kind: options.kind, sandboxId: (sandbox as FakeSandbox).id });
    (sandbox as FakeSandbox).markerAt = undefined;
    return { relayProcessId, agentProcessId };
  },
  async agentSessionStatus(sandbox, ids) {
    const session = host.sessions.get(ids.agentProcessId)!;
    if (session.polls++ === 0) return "running";
    if (host.outcome[session.kind] === "fail") return "failed";
    // The agent's calls went through the gateway, which recorded them under the token's stage and attempt.
    if ((sandbox as FakeSandbox).markerAt === undefined) {
      const claims = verifyGatewayToken(session.token, SECRET)!;
      const id = await startUsageCall(database, claims.scanId, { stage: claims.stage, role: "agent", attempt: claims.attempt });
      await finishUsageCall(database, id, { status: "ok", inputTokens: 50, outputTokens: 5, costUsd: "0.002" });
      (sandbox as FakeSandbox).markerAt = Date.now();
    }
    return "finished";
  },
  async collectAgentSession(_sandbox, ids) {
    const session = host.sessions.get(ids.agentProcessId)!;
    session.stopped = true;
    session.collected++;
    if (host.outcome[session.kind] === "fail") return { verdicts: [], finished: false, turns: 1, error: "agent did not finish" };
    if (session.kind === "refute") {
      const entries = session.findings as slice.FindingsEntry[];
      const verdicts = entries.map((entry) => ({ id: entry.id, verdict: host.realSinks.includes(entry.sink) ? "real" : "false", attacker: "any signed-in user", blocker: "none", victim: "other workspaces' projects", reason: "No ownership check." }));
      return { verdicts: slice.parseVerdicts(JSON.stringify(verdicts)), finished: true, turns: 4, exitCode: 0 };
    }
    const [first] = session.findings as slice.ConfirmedEntry[];
    const variants = [{ id: "V1", variant_of: first!.id, verdict: "real", attacker: "any signed-in user", location: `${PATH}:23`, victim: "other workspaces' projects", reason: "Archive has the same missing check." }];
    return { verdicts: slice.parseVerdicts(JSON.stringify(variants)), finished: true, turns: 3, exitCode: 0 };
  },
};

// ---- Fake GitHub --------------------------------------------------------------

const fakeGithub = {
  installation: () => ({
    cloneToken: async () => "token",
    pullFiles: async () => [],
    createCheckRun: async () => 1,
    completeCheckRun: async () => {},
  }),
} as unknown as GitHubApp;

// ---- Setup --------------------------------------------------------------------

const autumn = new FakeAutumn("chest");
let orgId = "";
let repoCount = 0;

beforeAll(async () => {
  try {
    admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${NAME}`);
  } catch {
    available = false;
    return;
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${NAME}`;
  for (const key of [...Object.keys(ENV), "DATABASE_URL", "SANDCHEST_ENGINE_ORGS"]) saved[key] = process.env[key];
  Object.assign(process.env, ENV, { DATABASE_URL: url.toString() });
  delete process.env.SANDCHEST_ENGINE_ORGS;
  resetConfig();
  database = createDb(url.toString(), { max: 5 });
  await migrate(database);
  setServices({ db: database, github: fakeGithub, slice: fakeLlm, sliceRuntime: runtime });
  setAutumn(autumn);
  const { org } = await upsertInstallation(database, 77, { githubAccountId: 900, githubLogin: "acme", type: "Organization" }, []);
  orgId = org.id;
});

afterAll(async () => {
  setAutumn(undefined);
  setServices({ slice: undefined, sliceRuntime: undefined });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
  if (!available || !admin) return;
  await database.$client.end();
  await admin.unsafe(`drop database if exists ${NAME} with (force)`);
  await admin.end();
});

const it = (name: string, fn: () => Promise<void>) =>
  test(
    name,
    async () => {
      if (!available) return console.warn(`skipped (no Postgres): ${name}`);
      host.reset();
      model.costUsd = 0.001;
      model.empty = false;
      model.requests = [];
      await fn();
    },
    30_000,
  );

/** A queued scan of a fresh repository, so scans never share a repository's one active deep scan. */
async function newScan(kind: "deep" | "pr_review" | "recon" | "fix_check" = "deep"): Promise<string> {
  repoCount++;
  const [repo] = await upsertRepos(database, orgId, [{ githubRepoId: 5000 + repoCount, fullName: `acme/app-${repoCount}`, private: true, defaultBranch: "main" }]);
  const { scan } = await createScan(database, { repoId: repo!.id, orgId, kind, trigger: "manual", headSha: "HEAD", ...(kind === "pr_review" && { prNumber: repoCount, headSha: `head${repoCount}` }) });
  return scan.id;
}

/** A session as the workflow drives it: start, poll until it ends (the sleeps left out), collect. */
async function session(scanId: string, kind: SessionKind): Promise<number> {
  if (!(await startSliceSession(scanId, kind)).started) return 0;
  let state = "running";
  for (let polls = 0; state === "running" && polls < 5; polls++) ({ state } = await sliceSessionStatus(scanId, kind));
  if (state === "failed" && kind === "verify") throw new Error("The verification in the sandbox stopped before it finished. Nothing was charged.");
  return (await collectSliceSession(scanId, kind, { timedOut: state === "running" })).real;
}

/** The workflow's slice path, then its fail path when a step throws. Returns the error, if one ended it. */
async function runSlice(scanId: string): Promise<Error | undefined> {
  expect(await beginScan(scanId)).toEqual({ state: "running", engine: "slice" });
  try {
    const { selected } = await huntSlice(scanId, { passDelayMs: 0 });
    if (selected > 0 && (await session(scanId, "verify")) > 0) await session(scanId, "variants");
    await writeUpSlice(scanId);
    await publishSlice(scanId);
    return undefined;
  } catch (error) {
    await cleanUpSlice(scanId);
    await failScan(scanId, (error as Error).message);
    return error as Error;
  }
}

const usage = (scanId: string) => scanUsageRows(database, scanId);
const sandboxOf = async (scanId: string) => host.sandboxes.get(sliceState((await scanById(database, scanId))!).sandboxId!)!;
const stagesOf = async (scanId: string) => (await scanStageRows(database, scanId)).map((s) => ({ stage: s.stage, attempt: s.attempt, ended: s.endedAt !== null, outcome: s.outcome, startedAt: s.startedAt, endedAt: s.endedAt }));

// ---- Tests --------------------------------------------------------------------

describe.skipIf(!available)("slice engine, step by step", () => {
  it("finds, verifies, follows variants, writes up and completes as a deep scan, charged as one", async () => {
    const scanId = await newScan();
    const credits = autumn.get(orgId).credits;
    expect(await runSlice(scanId)).toBeUndefined();

    const scan = (await scanById(database, scanId))!;
    expect(scan).toMatchObject({ status: "completed", billing: "charged", credits: 5 });
    expect(autumn.get(orgId).credits).toBe(credits - 5);
    const stats = scan.stats as { findingIds: string[]; newFindingIds: string[]; loc: number; slice: Record<string, unknown> };
    expect(stats.findingIds).toHaveLength(2);
    expect(stats.newFindingIds).toHaveLength(2);
    expect(stats.loc).toBe(LOC);
    // State between steps is ids and numbers only.
    expect(JSON.stringify(stats.slice)).not.toMatch(/ownership|projects|idor|Missing/);
    expect(stats.slice).toMatchObject({ selected: 2, loc: LOC, written: true, findings: 2 });
    const findings = await database.query.findings.findMany({ where: (f, { inArray }) => inArray(f.id, stats.findingIds) });
    expect(findings.map((f) => (f.attackPath as Array<{ line: number }>).at(-1)!.line).sort((a, b) => a - b)).toEqual([3, 23]);
    expect((await database.query.repos.findFirst({ where: (r, { eq }) => eq(r.id, scan.repoId) }))!.loc).toBe(LOC);

    // Every call in the ledger: the hunt's and the write-up's under their steps, the agent's from the gateway, the sandbox once.
    const rows = await usage(scanId);
    const by = (step: string) => rows.filter((r) => r.step === step);
    expect(by("hunt").filter((r) => r.kind === "model").every((r) => r.attempt === 0 && r.status === "ok" && ["slice_hunt", "slice_score"].includes(r.stage))).toBe(true);
    expect(by("hunt").filter((r) => r.kind === "model").length).toBeGreaterThanOrEqual(6);
    expect(by("writeup").length).toBeGreaterThan(0);
    expect(by("writeup").every((r) => r.attempt === 0 && r.kind === "model")).toBe(true);
    expect(by("verify").map((r) => [r.role, r.attempt])).toEqual([["agent", 0]]);
    expect(by("variants").map((r) => [r.role, r.attempt])).toEqual([["agent", 0]]);
    const sandboxRows = rows.filter((r) => r.kind === "sandbox");
    const sandbox = await sandboxOf(scanId);
    expect(sandboxRows.map((r) => [r.step, r.attempt, r.costUsd, r.key])).toEqual([["hunt", 0, "0.2500000000", sandboxKey(sandbox.id)]]);
    expect(sandbox.destroyed).toBe(true);
    // The indexer was started again for the write-up, after the first one was stopped.
    expect(sandbox.indexerStarts).toBe(2);
    expect(sandbox.execs.some((cmd) => cmd.at(-1) === STOP_INDEXER)).toBe(true);
    expect(sandbox.ttl).toEqual([5400, 5400, 5400]);
    // The server file came in the bulk read, asked for by name in a private list file; nothing was read one by one.
    expect(sandbox.privateBytes.size).toBeGreaterThan(1);
    expect([...sandbox.private.entries()].find(([name]) => name.startsWith("bulk-"))![1]).toBe(JSON.stringify([PATH]));
    expect(sandbox.singleReads).toEqual([]);

    const metrics = (await database.query.scanMetrics.findFirst({ where: (m, { eq }) => eq(m.scanId, scanId) }))!;
    expect(metrics).toMatchObject({ requests: rows.filter((r) => r.kind === "model").length, candidates: 2, survivors: 2, computeCostUsd: "0.250000" });

    // Every stage, started and ended.
    const stages = await stagesOf(scanId);
    expect(stages.map((s) => [s.stage, s.attempt, s.ended, s.outcome])).toEqual([
      ["queue", 0, true, "ok"],
      ["sandbox", 0, true, "ok"],
      ["select", 0, true, "ok"],
      ["hunt", 0, true, "ok"],
      ["score", 0, true, "ok"],
      ["verify", 0, true, "ok"],
      ["variants", 0, true, "ok"],
      ["writeup", 0, true, "ok"],
      ["publish", 0, true, "ok"],
    ]);
    for (const s of stages) expect(s.endedAt!.getTime()).toBeGreaterThanOrEqual(s.startedAt.getTime());

    // The feed: stage names the scan page knows, and findings by title only.
    const feed = await eventsSince(database, scanId, 0, 500);
    const known = new Set(TRACKS.deep!.map((s) => s.key));
    for (const event of feed.filter((e) => e.type.startsWith("stage:"))) expect(known.has(stepOf(event.type)!)).toBe(true);
    expect(new Set(feed.map((e) => e.type))).toEqual(new Set(["stage:setup", "stage:index", "stage:hunt", "stage:verify", "stage:done", "progress", "finding"]));
    expect(feed.filter((e) => e.type === "finding").map((e) => e.message.startsWith("Found: Missing ownership check"))).toEqual([true, true]);
    for (const event of feed) expect(event.message).not.toContain("req.params");
  });

  it("a bulk read that fails leaves the hunt to read files one by one, with the same result", async () => {
    host.packFails = true;
    const scanId = await newScan();
    expect(await runSlice(scanId)).toBeUndefined();
    const scan = (await scanById(database, scanId))!;
    expect(scan.status).toBe("completed");
    expect((scan.stats as { slice: Record<string, unknown> }).slice).toMatchObject({ selected: 2, findings: 2 });
    const sandbox = await sandboxOf(scanId);
    expect(sandbox.privateBytes.size).toBe(0);
    expect(sandbox.singleReads).toEqual([PATH]);
  });

  it("with no candidates, completes with no findings and still records the sandbox", async () => {
    model.empty = true;
    const scanId = await newScan();
    expect(await runSlice(scanId)).toBeUndefined();
    const scan = (await scanById(database, scanId))!;
    expect(scan).toMatchObject({ status: "completed", credits: 5 });
    expect((scan.stats as { findingIds: string[] }).findingIds).toEqual([]);
    expect(host.started).toEqual([]);
    expect((await usage(scanId)).filter((r) => r.kind === "sandbox")).toHaveLength(1);
    expect((await sandboxOf(scanId)).destroyed).toBe(true);
    const stages = await stagesOf(scanId);
    expect(stages.map((s) => s.stage)).not.toContain("verify");
    expect(stages.find((s) => s.stage === "writeup")).toMatchObject({ ended: true, outcome: "skipped" });
    expect((await database.query.scanMetrics.findFirst({ where: (m, { eq }) => eq(m.scanId, scanId) }))!).toMatchObject({ candidates: 0, survivors: 0 });
  });

  it("with no real verdicts, completes with no findings, no variants and no write-up calls", async () => {
    host.realSinks = [];
    const scanId = await newScan();
    expect(await runSlice(scanId)).toBeUndefined();
    expect(await scanById(database, scanId)).toMatchObject({ status: "completed" });
    expect(host.started.map((s) => s.kind)).toEqual(["refute"]);
    expect((await usage(scanId)).filter((r) => r.step === "writeup")).toHaveLength(0);
    const sandbox = await sandboxOf(scanId);
    expect(sandbox.indexerStarts).toBe(1);
    expect(sandbox.destroyed).toBe(true);
  });

  it("a variants session that fails, or never starts, leaves the scan to finish with what was verified", async () => {
    host.outcome.variants = "fail";
    const failed = await newScan();
    expect(await runSlice(failed)).toBeUndefined();
    const scan = (await scanById(database, failed))!;
    expect(scan.status).toBe("completed");
    expect((scan.stats as { findingIds: string[] }).findingIds).toHaveLength(1);
    expect((await stagesOf(failed)).find((s) => s.stage === "variants")).toMatchObject({ ended: true, outcome: "failed" });

    host.reset();
    host.outcome.variants = "throw";
    const unstarted = await newScan();
    expect(await runSlice(unstarted)).toBeUndefined();
    expect((await scanById(database, unstarted))!).toMatchObject({ status: "completed" });
    expect(((await scanById(database, unstarted))!.stats as { findingIds: string[] }).findingIds).toHaveLength(1);
  });

  it("a verification that fails fails the scan: nothing charged, sandbox deleted, its cost recorded", async () => {
    host.outcome.refute = "fail";
    const scanId = await newScan();
    const credits = autumn.get(orgId).credits;
    const error = await runSlice(scanId);
    expect(error?.message).toContain("verification in the sandbox stopped");
    expect(await scanById(database, scanId)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
    expect(autumn.get(orgId).credits).toBe(credits);
    expect((await sandboxOf(scanId)).destroyed).toBe(true);
    expect((await usage(scanId)).filter((r) => r.kind === "sandbox")).toHaveLength(1);
    const stages = await stagesOf(scanId);
    expect(stages.find((s) => s.stage === "verify")).toMatchObject({ ended: true, outcome: "failed" });
    expect(stages.every((s) => s.ended)).toBe(true);
    // Cleaning up twice records the sandbox once.
    await cleanUpSlice(scanId);
    expect((await usage(scanId)).filter((r) => r.kind === "sandbox")).toHaveLength(1);
  });

  it("a hunt step run again deletes the first sandbox and records under the next attempt", async () => {
    const scanId = await newScan();
    expect((await beginScan(scanId)).engine).toBe("slice");
    await huntSlice(scanId, { passDelayMs: 0 });
    const first = await sandboxOf(scanId);
    await huntSlice(scanId, { passDelayMs: 0 });
    const second = await sandboxOf(scanId);
    expect(second.id).not.toBe(first.id);
    expect(first.destroyed).toBe(true);
    expect(second.destroyed).toBe(false);
    expect(sliceState((await scanById(database, scanId))!)).toMatchObject({ huntAttempt: 1, sandboxId: second.id });
    expect([...new Set((await usage(scanId)).filter((r) => r.step === "hunt" && r.kind === "model").map((r) => r.attempt))]).toEqual([0, 1]);

    expect(await session(scanId, "verify")).toBe(1);
    await session(scanId, "variants");
    await writeUpSlice(scanId);
    await publishSlice(scanId);
    expect(await scanById(database, scanId)).toMatchObject({ status: "completed", credits: 5 });
    const sandboxes = (await usage(scanId)).filter((r) => r.kind === "sandbox");
    expect(sandboxes.map((r) => [r.attempt, r.key])).toEqual([
      [0, sandboxKey(first.id)],
      [1, sandboxKey(second.id)],
    ]);
    expect((await database.query.scanMetrics.findFirst({ where: (m, { eq }) => eq(m.scanId, scanId) }))!.computeCostUsd).toBe("0.500000");
    expect((await stagesOf(scanId)).filter((s) => s.stage === "hunt").map((s) => s.attempt)).toEqual([0, 1]);
  });

  it("the spending ceiling stops the hunt: no call starts past it, and nothing is charged", async () => {
    model.costUsd = 0.2;
    const scanId = await newScan();
    const error = await runSlice(scanId);
    expect(error).toBeInstanceOf(ScanFinished);
    expect(error!.message).toContain("spending ceiling");
    // Three hunt passes were under way when the third crossed it; no scoring call followed.
    expect(model.requests.filter((r) => contentOf(r).includes(slice.SCORE_TASK))).toHaveLength(0);
    expect(model.requests).toHaveLength(3);
    expect(await scanById(database, scanId)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
    expect((await sandboxOf(scanId)).destroyed).toBe(true);

    // A step that begins at the ceiling stops before any call.
    const later = await newScan();
    expect((await beginScan(later)).engine).toBe("slice");
    await database.insert(schema.scanUsage).values({ scanId: later, kind: "model", stage: "hunt", costUsd: "0.5", costSource: "provider", step: "hunt" });
    model.requests = [];
    await expect(huntSlice(later, { passDelayMs: 0 })).rejects.toThrow("spending ceiling");
    expect(model.requests).toHaveLength(0);
    await cleanUpSlice(later);
    await failScan(later, "stopped");
  });

  it("a call that reports no cost stops the scan", async () => {
    model.costUsd = undefined;
    const scanId = await newScan();
    const error = await runSlice(scanId);
    expect(error).toBeInstanceOf(ScanFinished);
    expect(error!.message).toBe("A model call reported no cost, so the scan was stopped.");
    expect((await usage(scanId)).some((r) => r.status === "unpriced")).toBe(true);
    expect(await scanById(database, scanId)).toMatchObject({ status: "failed", billing: "released" });
    expect((await sandboxOf(scanId)).destroyed).toBe(true);
  });

  it("a sandbox that vanished between steps fails the scan cleanly", async () => {
    const scanId = await newScan();
    expect((await beginScan(scanId)).engine).toBe("slice");
    await huntSlice(scanId, { passDelayMs: 0 });
    const sandbox = await sandboxOf(scanId);
    sandbox.gone = true;
    await expect(startSliceSession(scanId, "verify")).rejects.toThrow("sandbox is gone");
    await cleanUpSlice(scanId);
    await failScan(scanId, "gone");
    expect(await scanById(database, scanId)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
    // Gone means nothing to read or delete.
    expect((await usage(scanId)).filter((r) => r.kind === "sandbox")).toHaveLength(0);
  });

  it("starting a session twice starts one, and collecting twice collects once", async () => {
    const scanId = await newScan();
    expect((await beginScan(scanId)).engine).toBe("slice");
    await huntSlice(scanId, { passDelayMs: 0 });
    expect(await startSliceSession(scanId, "verify")).toEqual({ started: true });
    expect(await startSliceSession(scanId, "verify")).toEqual({ started: true });
    expect(host.started).toHaveLength(1);
    const ids = sliceState((await scanById(database, scanId))!).sessions!.verify!;
    // The token names this scan, the stage, its attempt and the ceiling in micro-dollars.
    const token = host.sessions.get(ids.agentProcessId)!.token;
    expect(verifyGatewayToken(token, SECRET)).toMatchObject({ scanId, stage: "verify", attempt: 0, ceilingMicroUsd: 500_000 });
    expect(await sliceSessionStatus(scanId, "verify")).toEqual({ state: "running" });
    expect(await sliceSessionStatus(scanId, "verify")).toEqual({ state: "finished" });
    // The stage ends at the exit marker's time, from the sandbox.
    const sandbox = await sandboxOf(scanId);
    const verify = (await stagesOf(scanId)).find((s) => s.stage === "verify")!;
    expect(verify.endedAt!.getTime()).toBe(Math.max(Math.floor(sandbox.markerAt! / 1000) * 1000, verify.startedAt.getTime()));
    expect(await collectSliceSession(scanId, "verify")).toEqual({ real: 1 });
    expect(await collectSliceSession(scanId, "verify")).toEqual({ real: 1 });
    expect(host.sessions.get(ids.agentProcessId)!.collected).toBe(1);
    await cleanUpSlice(scanId);
    await failScan(scanId, "done with it");
  });
});

describe.skipIf(!available)("which engine a scan runs on", () => {
  const settle = (scanId: string) => failScan(scanId, "test over");

  it("classic with the setting unset", async () => {
    process.env.SANDCHEST_ENGINE = "";
    resetConfig();
    try {
      const scanId = await newScan();
      expect(await beginScan(scanId)).toEqual({ state: "running" });
      await settle(scanId);
    } finally {
      process.env.SANDCHEST_ENGINE = "slice";
      resetConfig();
    }
  });

  it("classic for every kind but deep", async () => {
    for (const kind of ["pr_review", "recon", "fix_check"] as const) {
      const scanId = await newScan(kind);
      const begun = await beginScan(scanId);
      expect(begun).toEqual({ state: begun.state });
      expect(begun.engine).toBeUndefined();
      await settle(scanId);
    }
  });

  it("classic for accounts SANDCHEST_ENGINE_ORGS does not name", async () => {
    process.env.SANDCHEST_ENGINE_ORGS = "example-org";
    resetConfig();
    try {
      const outside = await newScan();
      expect(await beginScan(outside)).toEqual({ state: "running" });
      await settle(outside);
      process.env.SANDCHEST_ENGINE_ORGS = "Example-Org,ACME";
      resetConfig();
      const inside = await newScan();
      expect(await beginScan(inside)).toEqual({ state: "running", engine: "slice" });
      await settle(inside);
    } finally {
      delete process.env.SANDCHEST_ENGINE_ORGS;
      resetConfig();
    }
  });
});
