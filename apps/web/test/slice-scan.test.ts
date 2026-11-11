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
  insertUsage,
  knownFindings,
  orgCarry,
  scanBill,
  scanById,
  scanStageRows,
  scanUsageRows,
  schema,
  startUsageCall,
  unsettledScans,
  updateScan,
  upsertInstallation,
  upsertRepos,
  type Db,
} from "@sandchest/db";
import { migrate } from "@sandchest/db/migrate";
import type { IndexerClient } from "@sandchest/engine/indexer";
import type { ChatRequest, ChatResult, LlmClient } from "@sandchest/engine/llm";
import { prReviewCredits } from "@sandchest/billing";
import { adoptKnownFingerprints, slice } from "@sandchest/engine/scan";
import { GitHubError, type CheckConclusion, type CheckOutput, type GitHubApp, type PullFile, type ReviewComment } from "@sandchest/github";
import type { ExecResult, RepoRef } from "@sandchest/workspace";
import { usdToMicroUsd } from "@sandchest/billing/usage";
import { setAutumn, settleScan } from "@/server/billing";
import { resetConfig } from "@/server/config";
import { requestDeepScan } from "@/server/dig";
import { verifyGatewayToken } from "@/server/gateway";
import { billView } from "@/lib/bill-view";
import { stepOf, TRACKS } from "@/lib/scan-progress";
import { quotePrReview, startPrReview } from "@/server/pr-review";
import { beginScan, failScan, PAUSED_WAIT, publishScan, REPO_UNREADABLE, ScanFinished, type BeginResult } from "@/server/scans";
import { resetSentry } from "@/server/sentry";
import { setServices } from "@/server/services";
import { resetSliceLimit } from "@/server/slice-limit";
import { setScanStarter } from "@/server/start";
import { billSlice } from "@/server/usage-billing";
import { SandboxGone, type SliceRuntime, type SliceSandbox } from "@/server/slice-runtime";
import { cleanUpSlice, collectSliceSession, huntSlice, publishSlice, RELAY_PORT, sandboxKey, SECOND_RELAY_PORT, sliceSessionStatus, sliceState, startSliceSession, STOP_INDEXER, writeUpSlice, type SessionKind } from "@/server/slice-scan";
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
  SANDCHEST_SLICE_CEILING_PR_USD: "0.3",
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

/** One more handler file, with one candidate for the hunt at its line 3. */
const HANDLER = /^src\/api\/handler\d+\.ts$/;
const handlerPath = (n: number) => `src/api/handler${String(n).padStart(2, "0")}.ts`;
const handlerFile = (n: number) => [`export async function handler${n}(req) {`, "  const id = req.params.id;", `  return db.items${n}.find(id);`, "}"];

/** The checkout: the invented repository, and `host.extraFiles` handler files beside it. */
function checkout(): Record<string, string> {
  const extra = Array.from({ length: host.extraFiles }, (_, i) => [handlerPath(i + 1), `${handlerFile(i + 1).join("\n")}\n`] as const);
  return { ...Object.fromEntries(extra), ...REPO };
}

/** A source file's lines; undefined for anything else. */
function sourceLines(file: string): string[] | undefined {
  return file === "README.md" ? undefined : checkout()[file]?.replace(/\n$/, "").split("\n");
}

function symbolAt(lines: string[], line: number): string | null {
  for (let i = line - 1; i >= 0; i--) {
    const m = lines[i]!.match(/function (\w+)/);
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
      locations: (args.locations as Array<{ file: string; line: number }>).map(({ file, line }) => {
        const lines = sourceLines(file);
        return lines && line <= lines.length ? { file, line, exists: true, text: lines[line - 1], symbol: symbolAt(lines, line), totalLines: lines.length } : { file, line, exists: false };
      }),
    }),
    read_file: (args) => {
      const lines = sourceLines(String(args.path)) ?? FILE;
      const start = Math.max(1, Number(args.startLine ?? 1));
      const end = Math.min(lines.length, Number(args.endLine ?? lines.length));
      return { path: args.path, startLine: start, endLine: end, totalLines: lines.length, truncated: false, content: `${lines.slice(start - 1, end).join("\n")}\n` };
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
  /** The requests of those that came through the fast client. */
  fastRequests: [] as ChatRequest[],
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
    if (model.empty) return reply("NONE");
    // Two candidates in the invented file, and one in each extra handler file shown.
    const rows = [...content.matchAll(/^\[(E\d+)\] \S+ (\S+)/gm)].flatMap(([, id, path]) => {
      if (path === PATH) return [`${id}|idor|a|${PATH}:3|other workspaces|project read without ownership check`, `${id}|sqli|a|${PATH}:17|all tenants|name reaches a raw query`];
      return HANDLER.test(path!) ? [`${id}|idor|a|${path}:3|other workspaces|item read without ownership check`] : [];
    });
    return reply(rows.length ? rows.join("\n") : "NONE");
  },
};

/** The fast client: the same answers, counted apart. */
const fastLlm: LlmClient = {
  config: { baseUrl: "http://fake-fast", apiKey: "k", model: "m" },
  async chat(request) {
    model.fastRequests.push(request);
    return fakeLlm.chat(request);
  },
};

// ---- The sandbox host -------------------------------------------------------------

interface FakeSession {
  kind: slice.AgentSessionKind;
  /** The slot it was started in: only the second verification session has one. */
  slot?: string;
  /** The relay port it was given. */
  port: number;
  findings: unknown[];
  token: string;
  polls: number;
  /** Ends having written no verdicts, whatever its kind's outcome. */
  empty?: boolean;
  /** Its model calls are in the ledger. */
  metered: boolean;
  stopped: boolean;
  collected: number;
}

/**
 * What the second verification session does. Beyond `finish`, `fail` and `throw`: `empty` ends having written no
 * verdicts, `cut` never ends and has ruled on its first five candidates, `unreadable` ends but cannot be collected.
 */
type SecondOutcome = "finish" | "fail" | "throw" | "empty" | "cut" | "unreadable";

/** What each session does: finish after `polls` status reads, or fail; and which verdicts it writes. */
const host = {
  sandboxes: new Map<string, FakeSandbox>(),
  sessions: new Map<number, FakeSession>(),
  started: [] as Array<{ kind: slice.AgentSessionKind; sandboxId: string; slot?: string }>,
  outcome: { refute: "finish", variants: "finish" } as Record<slice.AgentSessionKind, "finish" | "fail" | "throw">,
  second: "finish" as SecondOutcome,
  /** How many of the next first verification sessions end by themselves having written no verdicts. */
  emptyFirst: 0,
  /** What every clone fails with. */
  cloneFails: undefined as string | undefined,
  /** Sessions started and collected, in order, each by its token's stage. */
  log: [] as string[],
  /** Verify: sinks ruled real. Variants: one sibling of the first confirmed finding. */
  realSinks: [`${PATH}:3`],
  /** Handler files beside the invented repository, each one more candidate for the hunt. */
  extraFiles: 0,
  /** The bulk read's pack command fails. */
  packFails: false,
  /** The sandbox's meter cannot be read. */
  usageFails: false,
  nextId: 1,
  nextProcess: 100,
  reset() {
    this.outcome = { refute: "finish", variants: "finish" };
    this.second = "finish";
    this.emptyFirst = 0;
    this.cloneFails = undefined;
    this.log = [];
    this.realSinks = [`${PATH}:3`];
    this.extraFiles = 0;
    this.started = [];
    this.packFails = false;
    this.usageFails = false;
  },
};

/** What a session does: the second verification session's own outcome, else its kind's. */
const outcomeOf = (session: { kind: slice.AgentSessionKind; slot?: string; empty?: boolean }): SecondOutcome => (session.empty ? "empty" : session.slot === undefined ? host.outcome[session.kind] : host.second);
/** A session's exit marker in the agent directory. */
const exitMarker = (sandbox: FakeSandbox, slot?: string) => `${sandbox.agentDir}/${slice.sessionFiles(slot).exit}`;

/** The bulk read's pack as the sandbox writes it: the wanted files of the checkout, cut into parts. */
function pack(files: string[], partBytes: number): { parts: Buffer[]; summary: string } {
  const record = (kind: number, index: number, body = Buffer.alloc(0)) => {
    const h = Buffer.alloc(9);
    h[0] = kind;
    h.writeUInt32BE(index, 1);
    h.writeUInt32BE(body.length, 5);
    return Buffer.concat([h, body]);
  };
  const repo = checkout();
  const records = files.map((file, i) => (repo[file] === undefined ? record(0, i) : record(1, i, Buffer.from(repo[file]!))));
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
  /** The commit each clone checked out. */
  cloned: Array<string | undefined> = [];
  /** When each session's CLI ended, as its exit marker's time, by the marker's path. */
  readonly markers = new Map<string, number>();

  /** `setup` is the script the sandbox was made with. */
  constructor(
    readonly id: string,
    readonly setup = "",
  ) {}

  /** When the session with no slot ended. */
  get markerAt(): number | undefined {
    return this.markers.get(exitMarker(this));
  }

  private check(): void {
    if (this.gone || this.destroyed) throw new Error("sandbox is gone");
  }
  async clone(source: RepoRef): Promise<void> {
    this.check();
    if (host.cloneFails !== undefined) throw new Error(host.cloneFails);
    this.cloned.push(source.ref);
  }
  async exec(cmd: string[]): Promise<ExecResult> {
    this.check();
    this.execs.push(cmd);
    const ok = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false, durationMs: 1 });
    if (cmd.join(" ") === "git rev-parse HEAD") return ok("0123456789abcdef0123456789abcdef01234567\n");
    if (cmd.join(" ") === "git ls-files -z") return ok(Object.keys(checkout()).join("\0"));
    if (cmd[0] === "stat") {
      const at = this.markers.get(cmd.at(-1)!);
      return at === undefined ? { ...ok(""), exitCode: 1 } : ok(`${Math.floor(at / 1000)}\n`);
    }
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
    const text = checkout()[path];
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
    if (host.usageFails) throw new Error("meter unavailable");
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
    // The agent reaches its relay and nothing else: one port, or the two of a deep scan's verification sessions.
    expect(setupScript).toMatch(new RegExp(`LOOPBACK_PORTS='${RELAY_PORT}( ${SECOND_RELAY_PORT})?'`));
    expect(setupScript).toContain("ALLOW_HOSTS=''");
    expect(setupScript).toContain("DNS='no'");
    const sandbox = new FakeSandbox(`bx_fake${String(host.nextId++).padStart(4, "0")}`, setupScript);
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
    if (outcomeOf(options) === "throw") throw new Error("Relay exited before it was ready");
    // A session with no slot has the first relay port; the one with a slot, the second.
    expect(options.relay.port).toBe(options.slot === undefined ? RELAY_PORT : SECOND_RELAY_PORT);
    expect(options.relay.targetUrl).toBe("https://sandchest.test/api/gateway");
    const relayProcessId = host.nextProcess++;
    const agentProcessId = host.nextProcess++;
    const slot = options.slot === undefined ? {} : { slot: options.slot };
    const empty = options.kind === "refute" && options.slot === undefined && host.emptyFirst > 0 && host.emptyFirst-- > 0 ? { empty: true } : {};
    host.sessions.set(agentProcessId, { kind: options.kind, ...slot, ...empty, port: options.relay.port, findings: options.findings, token: options.relay.token, polls: 0, metered: false, stopped: false, collected: 0 });
    host.started.push({ kind: options.kind, sandboxId: (sandbox as FakeSandbox).id, ...slot });
    host.log.push(`start:${verifyGatewayToken(options.relay.token, SECRET)!.stage}`);
    (sandbox as FakeSandbox).markers.delete(exitMarker(sandbox as FakeSandbox, options.slot));
    return { relayProcessId, agentProcessId, ...slot };
  },
  async agentSessionStatus(sandbox, ids) {
    const session = host.sessions.get(ids.agentProcessId)!;
    expect(ids.slot).toBe(session.slot);
    const outcome = outcomeOf(session);
    const first = session.polls++ === 0;
    // The agent's calls went through the gateway, which recorded them under the token's stage and attempt. The
    // second verification session's are there from its first poll, so one that fails or is cut has spent something.
    if (!session.metered && (session.slot === undefined ? !first && outcome !== "fail" : true)) {
      const claims = verifyGatewayToken(session.token, SECRET)!;
      const id = await startUsageCall(database, claims.scanId, { stage: claims.stage, role: "agent", attempt: claims.attempt });
      await finishUsageCall(database, id, { status: "ok", inputTokens: 50, outputTokens: 5, costUsd: session.slot === undefined ? "0.002" : "0.003" });
      session.metered = true;
    }
    if (first || outcome === "cut") return "running";
    if (outcome === "fail") return "failed";
    const marker = exitMarker(sandbox as FakeSandbox, session.slot);
    if (!(sandbox as FakeSandbox).markers.has(marker)) (sandbox as FakeSandbox).markers.set(marker, Date.now());
    return "finished";
  },
  async collectAgentSession(_sandbox, ids) {
    const session = host.sessions.get(ids.agentProcessId)!;
    expect(ids.slot).toBe(session.slot);
    session.stopped = true;
    session.collected++;
    host.log.push(`collect:${verifyGatewayToken(session.token, SECRET)!.stage}`);
    const outcome = outcomeOf(session);
    if (outcome === "unreadable") throw new Error("The sandbox did not answer");
    if (outcome === "fail") return { verdicts: [], finished: false, turns: 1, error: "agent did not finish" };
    if (outcome === "empty") return { verdicts: [], finished: true, turns: 2, exitCode: 0, error: "no verdicts file" };
    if (session.kind === "refute") {
      const entries = (session.findings as slice.FindingsEntry[]).slice(0, outcome === "cut" ? 5 : undefined);
      const verdicts = entries.map((entry) => ({ id: entry.id, verdict: host.realSinks.includes(entry.sink) ? "real" : "false", attacker: "any signed-in user", blocker: "none", victim: "other workspaces' projects", reason: "No ownership check." }));
      if (outcome === "cut") return { verdicts: slice.parseVerdicts(JSON.stringify(verdicts)), finished: false, turns: 9, error: "agent did not finish" };
      return { verdicts: slice.parseVerdicts(JSON.stringify(verdicts)), finished: true, turns: 4, exitCode: 0 };
    }
    const [first] = session.findings as slice.ConfirmedEntry[];
    const variants = [{ id: "V1", variant_of: first!.id, verdict: "real", attacker: "any signed-in user", location: `${PATH}:23`, victim: "other workspaces' projects", reason: "Archive has the same missing check." }];
    return { verdicts: slice.parseVerdicts(JSON.stringify(variants)), finished: true, turns: 3, exitCode: 0 };
  },
};

// ---- Fake GitHub --------------------------------------------------------------

/** A pull request's files, the text GitHub returns for each at a commit, and what was posted. */
const gh = {
  files: [] as PullFile[],
  contents: { ...REPO } as Record<string, string | undefined>,
  /** Reading these fails as GitHub failing would. */
  failing: new Set<string>(),
  reads: [] as string[],
  checks: [] as Array<{ conclusion: CheckConclusion; output: CheckOutput }>,
  reviews: [] as Array<{ commitId: string; comments: ReviewComment[] }>,
  comments: [] as string[],
  /** The repositories the installation lists, by GitHub id. */
  listed: [] as number[],
  reset() {
    this.listed = [];
    this.files = [];
    this.contents = { ...REPO };
    this.failing = new Set();
    this.reads = [];
    this.checks = [];
    this.reviews = [];
    this.comments = [];
  },
};

const fakeGithub = {
  installation: () => ({
    repositories: async () => gh.listed.map((id) => ({ id, full_name: `acme/listed-${id}`, private: true, default_branch: "main" })),
    cloneToken: async () => "token",
    pullFiles: async () => gh.files,
    pull: async (_repo: string, number: number) => ({ state: "open", head: { sha: `pull${number}` }, base: { sha: "base" } }),
    branchSha: async () => "HEAD",
    fileAt: async (_repo: string, path: string, ref: string) => {
      gh.reads.push(`${path}@${ref}`);
      if (gh.failing.has(path)) throw new GitHubError("GitHub 502: Bad Gateway", 502, true);
      return gh.contents[path];
    },
    createCheckRun: async () => 1,
    completeCheckRun: async (_repo: string, _id: number, conclusion: CheckConclusion, output: CheckOutput) => {
      gh.checks.push({ conclusion, output });
    },
    createReview: async (_repo: string, _number: number, input: { commitId: string; comments: ReviewComment[] }) => {
      gh.reviews.push(input);
    },
    comment: async (_repo: string, _number: number, body: string) => {
      gh.comments.push(body);
      return 1000 + gh.comments.length;
    },
    editComment: async () => {},
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
  setServices({ db: database, github: fakeGithub, slice: fakeLlm, sliceFast: fastLlm, sliceRuntime: runtime });
  setAutumn(autumn);
  const { org } = await upsertInstallation(database, 77, { githubAccountId: 900, githubLogin: "acme", type: "Organization" }, []);
  orgId = org.id;
});

afterAll(async () => {
  setAutumn(undefined);
  setServices({ slice: undefined, sliceFast: undefined, sliceRuntime: undefined });
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
      gh.reset();
      model.costUsd = 0.001;
      model.empty = false;
      model.requests = [];
      model.fastRequests = [];
      await fn();
    },
    30_000,
  );

/** A queued scan of a fresh repository, so scans never share a repository's one active deep scan. */
async function newScan(kind: "deep" | "pr_review" | "recon" | "fix_check" = "deep", options: { fast?: boolean } = {}): Promise<string> {
  repoCount++;
  const [repo] = await upsertRepos(database, orgId, [{ githubRepoId: 5000 + repoCount, fullName: `acme/app-${repoCount}`, private: true, defaultBranch: "main" }]);
  const { scan } = await createScan(database, { repoId: repo!.id, orgId, kind, trigger: "manual", headSha: "HEAD", ...(kind === "pr_review" && { prNumber: repoCount, headSha: `head${repoCount}` }), ...(options.fast && { fast: true }) });
  return scan.id;
}

/**
 * Sessions as the workflow drives them: started one after another, polled until every one has ended (the sleeps
 * left out) or the polls run out, then collected in order. Returns how many verdicts were real across them.
 */
async function sessions(scanId: string, kinds: SessionKind[]): Promise<number> {
  const states = new Map<SessionKind, string>();
  for (const kind of kinds) {
    if ((await startSliceSession(scanId, kind)).started) states.set(kind, "running");
    else if (kind === "verify") return 0;
  }
  const running = () => [...states].filter(([, state]) => state === "running").map(([kind]) => kind);
  const failed = () => states.get("verify") === "failed";
  for (let polls = 0; running().length > 0 && !failed() && polls < 5; polls++) {
    for (const kind of running()) if (!failed()) states.set(kind, (await sliceSessionStatus(scanId, kind)).state);
  }
  if (failed()) throw new Error("The verification in the sandbox stopped before it finished. Nothing was charged.");
  let real = 0;
  for (const [kind, state] of states) {
    const collected = await collectSliceSession(scanId, kind, { timedOut: state === "running" });
    real += collected.restart ? await sessions(scanId, [kind]) : collected.real;
  }
  return real;
}

/** One session as the workflow drives it. */
const session = (scanId: string, kind: SessionKind) => sessions(scanId, [kind]);

/** Verification, then variants, as the workflow runs them from the hunt step's result (one recorded by older code has no `secondBand`). */
async function verifyThenVariants(scanId: string, hunt: { selected: number; variants?: boolean; secondBand?: boolean }): Promise<void> {
  const confirmed = hunt.selected > 0 ? await sessions(scanId, hunt.secondBand === true ? ["verify", "verify2"] : ["verify"]) : 0;
  if (confirmed > 0 && hunt.variants !== false) await sessions(scanId, ["variants"]);
}

/** The workflow's slice path, then its fail path when a step throws. Returns the error, if one ended it. */
async function runSlice(scanId: string): Promise<Error | undefined> {
  expect(await beginScan(scanId)).toEqual({ state: "running", engine: "slice" });
  try {
    await verifyThenVariants(scanId, await huntSlice(scanId, { passDelayMs: 0 }));
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
    expect(scan).toMatchObject({ status: "completed", billing: "charged", credits: 500 });
    expect(autumn.get(orgId).credits).toBe(credits - 500);
    const stats = scan.stats as { findingIds: string[]; newFindingIds: string[]; loc: number; slice: Record<string, unknown> };
    // The confirmed finding and its variant are one finding.
    expect(stats.findingIds).toHaveLength(1);
    expect(stats.newFindingIds).toEqual(stats.findingIds);
    expect(stats.loc).toBe(LOC);
    // State between steps is ids and numbers only.
    expect(JSON.stringify(stats.slice)).not.toMatch(/ownership|projects|idor|Missing/);
    expect(stats.slice).toMatchObject({ selected: 2, loc: LOC, written: true, findings: 1 });
    const findings = await database.query.findings.findMany({ where: (f, { inArray }) => inArray(f.id, stats.findingIds) });
    // It lands where the confirmed finding does, and lists the variant's place, stored with it.
    expect(findings.map((f) => (f.attackPath as Array<{ line: number }>).at(-1)!.line)).toEqual([3]);
    const place = { title: "Missing ownership check (V1)", category: "broken_access_control", at: `${PATH}:23`, entry: `${PATH}:23`, variant: true, text: "return db.projects.archive(req.params.id);" };
    expect(findings[0]!.alsoReported).toEqual([place]);
    expect(findings[0]!.fixPrompt).toContain(`## Also affects\nThe same flaw is at 1 other place. The fix is needed at each one, and the regression test should cover every one:\n- \`${PATH}:23\`: Missing ownership check (V1)\n`);
    expect(await database.query.findings.findMany({ where: (f, { eq }) => eq(f.repoId, scan.repoId) })).toHaveLength(1);
    // A later scan that reports only the variant's place is recognised as this finding, not stored as a new one.
    const stored = await knownFindings(database, scan.repoId);
    expect(stored.map((k) => k.alsoReportedAs)).toEqual([[place]]);
    const elsewhere = { fingerprint: "another", category: "broken_access_control", entryPoint: { file: PATH, line: 21 }, attackPath: [{ file: PATH, line: 23 }] };
    expect(adoptKnownFingerprints([elsewhere], stored)[0]!.fingerprint).toBe(findings[0]!.fingerprint);
    expect(adoptKnownFingerprints([elsewhere], stored.map(({ alsoReportedAs: _, ...k }) => k))[0]!.fingerprint).toBe("another");
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
    expect(metrics).toMatchObject({ requests: rows.filter((r) => r.kind === "model").length, candidates: 2, survivors: 1, computeCostUsd: "0.250000" });

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
    // One finding, announced once: the variant is a place it lists, not a finding of its own.
    expect(feed.filter((e) => e.type === "finding").map((e) => e.message)).toEqual(["Found: Missing ownership check (F1)"]);
    expect(feed.find((e) => e.type === "stage:done")!.message).toBe("Found 1 finding: 1 high.");
    for (const event of feed) expect(event.message).not.toContain("req.params");
  });

  it("a bulk read that fails leaves the hunt to read files one by one, with the same result", async () => {
    host.packFails = true;
    const scanId = await newScan();
    expect(await runSlice(scanId)).toBeUndefined();
    const scan = (await scanById(database, scanId))!;
    expect(scan.status).toBe("completed");
    expect((scan.stats as { slice: Record<string, unknown> }).slice).toMatchObject({ selected: 2, findings: 1 });
    const sandbox = await sandboxOf(scanId);
    expect(sandbox.privateBytes.size).toBe(0);
    expect(sandbox.singleReads).toEqual([PATH]);
  });

  it("with no candidates, completes with no findings and still records the sandbox", async () => {
    model.empty = true;
    const scanId = await newScan();
    expect(await runSlice(scanId)).toBeUndefined();
    const scan = (await scanById(database, scanId))!;
    expect(scan).toMatchObject({ status: "completed", credits: 500 });
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
    expect(await scanById(database, scanId)).toMatchObject({ status: "completed", credits: 500 });
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

// ---- Pull request reviews -------------------------------------------------------

/** `getProject` rewritten: new lines 2-3 added, 1 and 4 context. */
const PATCH = ["@@ -1,3 +1,4 @@", " export async function getProject(req) {", "-  return db.projects.find(req.params.id);", "+  const id = req.params.id;", "+  return db.projects.find(id);", " }"].join("\n");
const pullFile = (filename: string, additions: number, deletions: number, patch?: string): PullFile => ({ filename, status: "modified", additions, deletions, ...(patch !== undefined && { patch }) });
const CHANGED = pullFile(PATH, 2, 1, PATCH);
const DOCS = pullFile("README.md", 1, 0, "@@ -1 +1 @@\n-acme\n+acme/app");

/** The review the classic engine would report for these files: security-relevant files and their lines. */
const classicReview = (files: PullFile[], reviewedFiles: string[], skippedFiles: string[] = []) => {
  const relevant = files.filter((f) => f.filename !== "README.md");
  return { files: relevant.length, changedLines: relevant.reduce((n, f) => n + f.additions + f.deletions, 0), reviewedFiles, skippedFiles };
};
const sandboxCount = () => host.sandboxes.size;

describe.skipIf(!available)("pull request reviews on the slice engine", () => {
  it("a change with no server-side code: no model call, no sandbox, charged and stored as the classic review", async () => {
    gh.files = [DOCS, pullFile("src/components/Button.tsx", 4, 1, "@@ -1 +1,4 @@\n-a\n+b\n+c\n+d\n+e")];
    const scanId = await newScan("pr_review");
    const credits = autumn.get(orgId).credits;
    const sandboxes = sandboxCount();
    expect(await runSlice(scanId)).toBeUndefined();

    const scan = (await scanById(database, scanId))!;
    expect(scan).toMatchObject({ status: "completed", billing: "charged", credits: prReviewCredits(5) });
    expect(autumn.get(orgId).credits).toBe(credits - prReviewCredits(5));
    const stats = scan.stats as Record<string, unknown>;
    expect(stats).toMatchObject({ findingIds: [], newFindingIds: [], review: classicReview(gh.files, []) });
    expect(model.requests).toHaveLength(0);
    expect(gh.reads).toEqual([]);
    expect(sandboxCount()).toBe(sandboxes);
    expect(gh.checks.at(-1)!.conclusion).toBe("success");
    expect(gh.comments).toHaveLength(1);
    expect((await stagesOf(scanId)).map((s) => [s.stage, s.outcome])).toEqual([
      ["queue", "ok"],
      ["select", "ok"],
      ["hunt", "ok"],
      ["score", "ok"],
      ["writeup", "skipped"],
      ["publish", "ok"],
    ]);
  });

  it("a hunt that selects nothing opens no sandbox, and completes the Check through the existing publish", async () => {
    model.empty = true;
    gh.files = [CHANGED, DOCS];
    const scanId = await newScan("pr_review");
    const sandboxes = sandboxCount();
    expect(await runSlice(scanId)).toBeUndefined();

    expect(sandboxCount()).toBe(sandboxes);
    expect(host.started).toEqual([]);
    const scan = (await scanById(database, scanId))!;
    expect(scan).toMatchObject({ status: "completed", billing: "charged", credits: prReviewCredits(3) });
    expect(scan.credits).toBe(scan.creditsReserved!);
    const stats = scan.stats as { findingIds: string[]; newFindingIds: string[]; review: unknown; slice: Record<string, unknown> };
    expect(stats.findingIds).toEqual([]);
    expect(stats.newFindingIds).toEqual([]);
    expect(stats.review).toEqual(classicReview(gh.files, [PATH]));
    expect(stats.slice).toMatchObject({ selected: 0, skipped: 0, written: true, findings: 0 });
    expect(stats.slice.sandboxId).toBeUndefined();
    // Only the changed server file was read, at the PR's head commit, and hunted with the change-review task.
    expect(gh.reads).toEqual([`${PATH}@${scan.headSha}`]);
    expect(model.requests.filter((r) => contentOf(r).includes(slice.CHANGE_TASK))).toHaveLength(3);
    const rows = await usage(scanId);
    expect(rows.every((r) => r.kind === "model" && r.step === "hunt")).toBe(true);
    expect(gh.checks.at(-1)!.conclusion).toBe("success");
    expect(gh.reviews).toEqual([]);
    const stages = await stagesOf(scanId);
    expect(stages.map((s) => [s.stage, s.outcome])).toEqual([
      ["queue", "ok"],
      ["select", "ok"],
      ["hunt", "ok"],
      ["score", "ok"],
      ["writeup", "skipped"],
      ["publish", "ok"],
    ]);
    expect((await database.query.scanMetrics.findFirst({ where: (m, { eq }) => eq(m.scanId, scanId) }))!).toMatchObject({ candidates: 0, survivors: 0 });
  });

  it("a confirmed finding: one sandbox at the head commit, verified, written up, posted inline; no variants", async () => {
    gh.files = [CHANGED, DOCS];
    const scanId = await newScan("pr_review");
    const credits = autumn.get(orgId).credits;
    const sandboxes = sandboxCount();
    expect(await runSlice(scanId)).toBeUndefined();

    expect(sandboxCount()).toBe(sandboxes + 1);
    const scan = (await scanById(database, scanId))!;
    expect(scan).toMatchObject({ status: "completed", billing: "charged", credits: prReviewCredits(3) });
    expect(autumn.get(orgId).credits).toBe(credits - prReviewCredits(3));
    const stats = scan.stats as { findingIds: string[]; newFindingIds: string[]; review: unknown; inline: number; slice: Record<string, unknown> };
    expect(stats.review).toEqual(classicReview(gh.files, [PATH]));
    // Only the candidate on a changed line was selected (line 17 is outside the change).
    expect(stats.slice).toMatchObject({ selected: 1, written: true, findings: 1 });
    expect(stats.findingIds).toHaveLength(1);
    expect(stats.newFindingIds).toEqual(stats.findingIds);
    const [finding] = await database.query.findings.findMany({ where: (f, { inArray }) => inArray(f.id, stats.findingIds) });
    expect((finding!.attackPath as Array<{ file: string; line: number }>).at(-1)).toMatchObject({ file: PATH, line: 3 });

    const sandbox = await sandboxOf(scanId);
    expect(sandbox.cloned).toEqual([scan.headSha]);
    expect(sandbox.destroyed).toBe(true);
    expect(host.started.map((s) => s.kind)).toEqual(["refute"]);
    // The verification's token carries the PR's own ceiling.
    const [verify] = [...host.sessions.values()].filter((s) => s.kind === "refute").slice(-1);
    expect(verifyGatewayToken(verify!.token, SECRET)).toMatchObject({ scanId, stage: "verify", ceilingMicroUsd: 300_000 });

    // Inline on the changed line, and the Check completed.
    expect(stats.inline).toBe(1);
    expect(gh.reviews).toHaveLength(1);
    expect(gh.reviews[0]!.commitId).toBe(scan.headSha);
    expect(gh.reviews[0]!.comments.map((c) => [c.path, c.line, c.side])).toEqual([[PATH, 3, "RIGHT"]]);
    expect(gh.checks.at(-1)!.conclusion).not.toBe("neutral");
    expect(gh.comments).toHaveLength(1);

    const rows = await usage(scanId);
    const by = (step: string) => rows.filter((r) => r.step === step);
    expect(by("hunt").filter((r) => r.kind === "model").every((r) => r.attempt === 0 && ["slice_hunt", "slice_score"].includes(r.stage))).toBe(true);
    expect(by("verify").map((r) => [r.role, r.attempt])).toEqual([["agent", 0]]);
    expect(by("variants")).toEqual([]);
    expect(by("writeup").length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.kind === "sandbox").map((r) => [r.step, r.attempt, r.key])).toEqual([["hunt", 0, sandboxKey(sandbox.id)]]);
    expect((await database.query.scanMetrics.findFirst({ where: (m, { eq }) => eq(m.scanId, scanId) }))!).toMatchObject({ candidates: 1, survivors: 1, computeCostUsd: "0.250000" });

    const stages = await stagesOf(scanId);
    expect(stages.map((s) => [s.stage, s.attempt, s.ended, s.outcome])).toEqual([
      ["queue", 0, true, "ok"],
      ["select", 0, true, "ok"],
      ["hunt", 0, true, "ok"],
      ["score", 0, true, "ok"],
      ["sandbox", 0, true, "ok"],
      ["verify", 0, true, "ok"],
      ["writeup", 0, true, "ok"],
      ["publish", 0, true, "ok"],
    ]);
    // The feed names steps the PR track knows, and no code.
    const feed = await eventsSince(database, scanId, 0, 500);
    const known = new Set(TRACKS.pr_review!.map((s) => s.key));
    for (const event of feed.filter((e) => e.type.startsWith("stage:"))) expect(known.has(stepOf(event.type)!)).toBe(true);
    for (const event of feed) expect(event.message).not.toContain("req.params");
  });

  it("a verification that fails fails the review: neutral Check, nothing charged, sandbox deleted", async () => {
    host.outcome.refute = "fail";
    gh.files = [CHANGED];
    const scanId = await newScan("pr_review");
    const credits = autumn.get(orgId).credits;
    const error = await runSlice(scanId);
    expect(error?.message).toContain("verification in the sandbox stopped");
    expect(await scanById(database, scanId)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
    expect(autumn.get(orgId).credits).toBe(credits);
    expect(gh.checks.at(-1)!.conclusion).toBe("neutral");
    expect((await sandboxOf(scanId)).destroyed).toBe(true);
    expect((await usage(scanId)).filter((r) => r.kind === "sandbox")).toHaveLength(1);
    const stages = await stagesOf(scanId);
    expect(stages.find((s) => s.stage === "verify")).toMatchObject({ ended: true, outcome: "failed" });
    expect(stages.every((s) => s.ended)).toBe(true);
  });

  it("the PR's own ceiling stops the hunt where a deep scan's would not", async () => {
    // Three hunt calls: under the deep ceiling, over the PR's.
    model.costUsd = 0.15;
    gh.files = [CHANGED];
    const scanId = await newScan("pr_review");
    const sandboxes = sandboxCount();
    const error = await runSlice(scanId);
    expect(error).toBeInstanceOf(ScanFinished);
    expect(error!.message).toContain("spending ceiling");
    expect(model.requests.filter((r) => contentOf(r).includes(slice.SCORE_TASK))).toHaveLength(0);
    expect(sandboxCount()).toBe(sandboxes);
    expect(await scanById(database, scanId)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
    expect(gh.checks.at(-1)!.conclusion).toBe("neutral");
    // Cleaning up a review that never made a sandbox does nothing more.
    await cleanUpSlice(scanId);
    expect((await usage(scanId)).filter((r) => r.kind === "sandbox")).toHaveLength(0);

    // What it spent is past the PR's ceiling and short of the deep scan's.
    const spent = (await usage(scanId)).reduce((sum, r) => sum + Number(r.costUsd), 0);
    expect(spent).toBeGreaterThanOrEqual(0.3);
    expect(spent).toBeLessThan(0.5);
  });

  it("a file GitHub gave no patch for, or whose text cannot be read, is left out and counted", async () => {
    model.empty = true;
    gh.contents["src/api/flaky.ts"] = "export const a = 1;\n";
    gh.failing.add("src/api/flaky.ts");
    gh.files = [CHANGED, pullFile("src/api/big.ts", 900, 10), pullFile("src/api/flaky.ts", 1, 0, "@@ -0,0 +1 @@\n+x"), pullFile("src/api/gone.ts", 1, 0, "@@ -0,0 +1 @@\n+y")];
    const scanId = await newScan("pr_review");
    expect(await runSlice(scanId)).toBeUndefined();

    const scan = (await scanById(database, scanId))!;
    // The charge counts every security-relevant line, as the classic review does, the files left out included.
    expect(scan).toMatchObject({ status: "completed", credits: prReviewCredits(914) });
    expect(scan.credits).toBe(200);
    expect(scan.credits).toBe(scan.creditsReserved!);
    const stats = scan.stats as { review: unknown; slice: Record<string, unknown> };
    expect(stats.review).toEqual(classicReview(gh.files, [PATH], ["src/api/big.ts", "src/api/flaky.ts", "src/api/gone.ts"]));
    expect(stats.slice).toMatchObject({ skipped: 3, selected: 0 });
    expect(gh.reads.map((r) => r.split("@")[0]).sort()).toEqual(["src/api/flaky.ts", "src/api/gone.ts", PATH]);
    for (const r of model.requests) for (const file of ["big.ts", "flaky.ts", "gone.ts"]) expect(contentOf(r)).not.toContain(file);
    expect(model.requests.length).toBeGreaterThan(0);
    const feed = await eventsSince(database, scanId, 0, 500);
    expect(feed.some((e) => e.message === "3 changed files were too large or could not be read, and were left out.")).toBe(true);
  });
});

// ---- Fast deep scans ------------------------------------------------------------

const FAST_ENV: Record<string, string> = { SANDCHEST_SLICE_CEILING_FAST_USD: "0.4", LLM_AGENT_FAST_MODEL: "fast-model", LLM_SLICE_FAST_BODY: '{"serving":"fast"}' };
const FAST_UNAVAILABLE = "Fast mode is not available right now, so this scan runs at standard speed.";

/** Runs `fn` with fast mode available (or with `env`), then puts the settings back. */
async function withFast(fn: () => Promise<void>, env: Record<string, string> = FAST_ENV): Promise<void> {
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  resetConfig();
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfig();
  }
}

/** The claims of every gateway token handed to this scan's sessions, in the order they started. */
const tokensOf = (scanId: string) =>
  [...host.sessions.values()].map((s) => verifyGatewayToken(s.token, SECRET)).filter((claims) => claims?.scanId === scanId);
const feedOf = async (scanId: string) => (await eventsSince(database, scanId, 0, 500)).map((e) => e.message);

describe.skipIf(!available)("fast deep scans", () => {
  it("a fast deep scan: every engine call on the fast client, fast tokens under the fast ceiling, otherwise as a standard scan", async () => {
    await withFast(async () => {
      const scanId = await newScan("deep", { fast: true });
      const credits = autumn.get(orgId).credits;
      expect(await runSlice(scanId)).toBeUndefined();

      const scan = (await scanById(database, scanId))!;
      expect(scan).toMatchObject({ status: "completed", billing: "charged", credits: 500, fast: true });
      expect(autumn.get(orgId).credits).toBe(credits - 500);
      expect((scan.stats as { findingIds: string[] }).findingIds).toHaveLength(1);
      expect(sliceState(scan)).toMatchObject({ fast: true, written: true, findings: 1 });
      // Hunt, scoring and write-up all went through the fast client.
      expect(model.requests.length).toBeGreaterThan(0);
      expect(model.fastRequests).toEqual(model.requests);
      expect(model.fastRequests.some((r) => contentOf(r).includes(slice.SCORE_TASK))).toBe(true);
      expect(model.fastRequests.some((r) => r.responseFormat?.json_schema.name === "finding")).toBe(true);
      // Both sessions' tokens send the agent's calls to the fast endpoint, under the fast ceiling.
      expect(tokensOf(scanId)).toMatchObject([
        { stage: "verify", attempt: 0, ceilingMicroUsd: 400_000, fast: true },
        { stage: "variants", attempt: 0, ceilingMicroUsd: 400_000, fast: true },
      ]);
      // Metered as any slice scan is.
      const rows = await usage(scanId);
      expect(rows.filter((r) => r.step === "hunt" && r.kind === "model").every((r) => r.attempt === 0 && r.status === "ok")).toBe(true);
      expect(rows.filter((r) => r.step === "writeup").length).toBeGreaterThan(0);
      expect(rows.filter((r) => r.step === "verify").map((r) => [r.role, r.attempt])).toEqual([["agent", 0]]);
      expect(rows.filter((r) => r.kind === "sandbox")).toHaveLength(1);
      expect(await feedOf(scanId)).not.toContain(FAST_UNAVAILABLE);
    });
  });

  it("a fast run is stopped by the fast ceiling, not the standard one", async () => {
    // Under the fast ceiling (0.4), three hunt calls of 0.15 cross it; under the standard one (0.5) they would not.
    await withFast(async () => {
      model.costUsd = 0.15;
      const scanId = await newScan("deep", { fast: true });
      const error = await runSlice(scanId);
      expect(error).toBeInstanceOf(ScanFinished);
      expect(error!.message).toContain("spending ceiling");
      expect(model.requests.filter((r) => contentOf(r).includes(slice.SCORE_TASK))).toHaveLength(0);
      expect(model.fastRequests).toHaveLength(3);
      const spent = (await usage(scanId)).filter((r) => r.kind === "model").reduce((sum, r) => sum + Number(r.costUsd), 0);
      expect(spent).toBeGreaterThanOrEqual(0.4);
      expect(spent).toBeLessThan(0.5);
      expect(await scanById(database, scanId)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
    });

    // A fast ceiling above the standard one: the hunt carries on past where a standard run would stop.
    await withFast(
      async () => {
        model.costUsd = 0.2;
        model.requests = [];
        const scanId = await newScan("deep", { fast: true });
        expect((await beginScan(scanId)).engine).toBe("slice");
        expect((await huntSlice(scanId, { passDelayMs: 0 })).selected).toBe(2);
        const spent = (await usage(scanId)).filter((r) => r.kind === "model").reduce((sum, r) => sum + Number(r.costUsd), 0);
        expect(spent).toBeGreaterThan(0.5);
        expect(model.requests.filter((r) => contentOf(r).includes(slice.SCORE_TASK)).length).toBeGreaterThan(0);
        await cleanUpSlice(scanId);
        await failScan(scanId, "test over");
      },
      { ...FAST_ENV, SANDCHEST_SLICE_CEILING_FAST_USD: "2.5" },
    );
  });

  it("a fast run whose fast settings disappear mid-scan stops; it never carries on as a standard run", async () => {
    let scanId = "";
    await withFast(async () => {
      scanId = await newScan("deep", { fast: true });
      expect((await beginScan(scanId)).engine).toBe("slice");
      await huntSlice(scanId, { passDelayMs: 0 });
      expect(sliceState((await scanById(database, scanId))!).fast).toBe(true);
    });
    // The fast ceiling is gone; the standard one is still set.
    await expect(startSliceSession(scanId, "verify")).rejects.toThrow("The slice engine is no longer configured.");
    expect(host.started).toEqual([]);
    expect(tokensOf(scanId)).toEqual([]);
    const before = model.requests.length;
    await expect(writeUpSlice(scanId)).rejects.toThrow("The slice engine is no longer configured.");
    expect(model.requests).toHaveLength(before);
    await cleanUpSlice(scanId);
    await failScan(scanId, "stopped");
    expect(await scanById(database, scanId)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
  });

  it("a scan flagged fast while fast mode is not available runs standard, and its feed says so once", async () => {
    const scanId = await newScan("deep", { fast: true });
    expect(await runSlice(scanId)).toBeUndefined();
    const scan = (await scanById(database, scanId))!;
    expect(scan).toMatchObject({ status: "completed", credits: 500, fast: true });
    expect(sliceState(scan).fast).toBe(false);
    expect(model.requests.length).toBeGreaterThan(0);
    expect(model.fastRequests).toEqual([]);
    const tokens = tokensOf(scanId);
    expect(tokens).toMatchObject([
      { stage: "verify", ceilingMicroUsd: 500_000 },
      { stage: "variants", ceilingMicroUsd: 500_000 },
    ]);
    for (const claims of tokens) expect(claims!.fast).toBeUndefined();
    expect((await feedOf(scanId)).filter((m) => m === FAST_UNAVAILABLE)).toHaveLength(1);
  });

  it("with fast mode available, an unflagged deep scan runs exactly as before", async () => {
    await withFast(async () => {
      const scanId = await newScan();
      expect(await runSlice(scanId)).toBeUndefined();
      const scan = (await scanById(database, scanId))!;
      expect(scan).toMatchObject({ status: "completed", credits: 500, fast: false });
      expect("fast" in sliceState(scan)).toBe(false);
      expect(model.fastRequests).toEqual([]);
      const tokens = tokensOf(scanId);
      expect(tokens.map((claims) => [claims!.stage, claims!.ceilingMicroUsd])).toEqual([
        ["verify", 500_000],
        ["variants", 500_000],
      ]);
      for (const claims of tokens) expect(Object.keys(claims!)).not.toContain("fast");
      expect(await feedOf(scanId)).not.toContain(FAST_UNAVAILABLE);
    });
  });

  it("a pull request review flagged fast runs standard, under its own ceiling", async () => {
    await withFast(async () => {
      gh.files = [CHANGED, DOCS];
      const scanId = await newScan("pr_review", { fast: true });
      expect(await runSlice(scanId)).toBeUndefined();
      expect(await scanById(database, scanId)).toMatchObject({ status: "completed", credits: prReviewCredits(3) });
      expect(model.requests.length).toBeGreaterThan(0);
      expect(model.fastRequests).toEqual([]);
      const tokens = tokensOf(scanId);
      expect(tokens).toMatchObject([{ stage: "verify", ceilingMicroUsd: 300_000 }]);
      expect(tokens[0]!.fast).toBeUndefined();
    });
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
      const review = await newScan("pr_review");
      expect(await beginScan(review)).toEqual({ state: "running" });
      await settle(review);
    } finally {
      process.env.SANDCHEST_ENGINE = "slice";
      resetConfig();
    }
  });

  it("classic for every kind but deep scans and PR reviews", async () => {
    for (const kind of ["recon", "fix_check"] as const) {
      const scanId = await newScan(kind);
      const begun = await beginScan(scanId);
      expect(begun).toEqual({ state: begun.state });
      expect(begun.engine).toBeUndefined();
      await settle(scanId);
    }
    const review = await newScan("pr_review");
    expect(await beginScan(review)).toEqual({ state: "running", engine: "slice" });
    await settle(review);
  });

  it("classic for accounts SANDCHEST_ENGINE_ORGS does not name", async () => {
    process.env.SANDCHEST_ENGINE_ORGS = "example-org";
    resetConfig();
    try {
      const outside = await newScan();
      expect(await beginScan(outside)).toEqual({ state: "running" });
      await settle(outside);
      const outsideReview = await newScan("pr_review");
      expect(await beginScan(outsideReview)).toEqual({ state: "running" });
      await settle(outsideReview);
      process.env.SANDCHEST_ENGINE_ORGS = "Example-Org,ACME";
      resetConfig();
      const inside = await newScan();
      expect(await beginScan(inside)).toEqual({ state: "running", engine: "slice" });
      await settle(inside);
      const insideReview = await newScan("pr_review");
      expect(await beginScan(insideReview)).toEqual({ state: "running", engine: "slice" });
      await settle(insideReview);
    } finally {
      delete process.env.SANDCHEST_ENGINE_ORGS;
      resetConfig();
    }
  });
});

// ---- Usage billing ----------------------------------------------------------------

/** Made-up settings: a multiplier of 3 at reservation. */
const SHADOW_ENV = { SANDCHEST_USAGE_BILLING: "shadow", SANDCHEST_USAGE_MULTIPLIER: "3" };
const USAGE_ENV = { SANDCHEST_USAGE_BILLING: "on", SANDCHEST_USAGE_MULTIPLIER: "3", NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: "cent" };
const USAGE_KEYS = ["SANDCHEST_USAGE_BILLING", "SANDCHEST_USAGE_MULTIPLIER", "NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT"];
const TIERED = { engine: "slice", mode: "tiered", unit: "cent" } as const;

/** Runs `fn` with usage billing unset, then `env` on top (blank means unset), then puts every setting back. */
async function withSettings(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const keys = [...new Set([...USAGE_KEYS, ...Object.keys(env)])];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of USAGE_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  resetConfig();
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfig();
  }
}

/** The slice steps up to the write-up, as the workflow runs them, after a begin step that must answer `expected`. */
async function throughWriteUp(scanId: string, expected: BeginResult): Promise<void> {
  expect(await beginScan(scanId)).toEqual(expected);
  await verifyThenVariants(scanId, await huntSlice(scanId, { passDelayMs: 0 }));
  await writeUpSlice(scanId);
}

/** The bill step as the workflow polls it, the sleeps left out: the 41st poll is the last. */
async function bill(scanId: string) {
  for (let polls = 0; ; polls++) {
    const result = await billSlice(scanId, { final: polls >= 40 });
    if (result.state !== "waiting") return result;
  }
}

/** The workflow's slice path, with the bill step only when the begin result asks for it. */
async function runBilled(scanId: string, expected: BeginResult): Promise<void> {
  await throughWriteUp(scanId, expected);
  if (expected.pricing) await bill(scanId);
  await publishSlice(scanId);
}

/** What the sweep does for a scan that ended still holding credits, for this scan alone. */
async function sweepSettle(scanId: string): Promise<void> {
  for (const scan of (await unsettledScans(database, 1_000)).filter((row) => row.id === scanId)) await settleScan(scan, scan.status === "completed" ? "charge" : "release", scan.credits);
}

const ledgerMicroUsd = async (scanId: string) => (await usage(scanId)).reduce((sum, r) => sum + usdToMicroUsd(r.costUsd), 0);
const resetCarry = () => database.$client`delete from usage_carry where org_id = ${orgId}`;

/** A repository of its own, with its org, for Dig and dashboard reviews. */
async function newRepo() {
  repoCount++;
  const [repo] = await upsertRepos(database, orgId, [{ githubRepoId: 5000 + repoCount, fullName: `acme/app-${repoCount}`, private: true, defaultBranch: "main" }]);
  return (await database.query.repos.findFirst({ where: (r, { eq }) => eq(r.id, repo!.id), with: { org: true } }))!;
}

/** A Sentry on localhost for `fn`; returns the tags of every event it received. */
async function withSentry(fn: () => Promise<void>): Promise<Array<Record<string, unknown>>> {
  const tags: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const [, , event] = (await request.text()).trim().split("\n").map((line) => JSON.parse(line) as { tags?: Record<string, unknown> });
      tags.push(event?.tags ?? {});
      return new Response("{}");
    },
  });
  process.env.SENTRY_DSN = `http://publickey@127.0.0.1:${server.port}/5`;
  resetSentry();
  try {
    await fn();
  } finally {
    delete process.env.SENTRY_DSN;
    resetSentry();
    server.stop(true);
  }
  return tags;
}

describe.skipIf(!available)("usage billing off", () => {
  it("slice deep scans and PR reviews reserve, charge and run exactly as before; the row also says how they were priced", async () => {
    await withSettings({}, async () => {
      autumn.get(orgId).credits = 100_000;
      const deep = await newScan();
      const calls = autumn.calls.length;
      expect(await runSlice(deep)).toBeUndefined();
      const scan = (await scanById(database, deep))!;
      // Not sized yet: the top tier is held, and the tier of what the hunt measured is charged.
      expect(scan).toMatchObject({ status: "completed", billing: "charged", creditsReserved: 2_500, credits: 500 });
      expect(scan.pricing).toEqual(TIERED);
      expect(autumn.get(orgId).credits).toBe(99_500);
      expect(autumn.calls.slice(calls).filter((c) => c === "reserve" || c === "finalize")).toEqual(["reserve", "finalize"]);
      expect(await scanBill(database, deep)).toBeUndefined();
      expect("unwritten" in sliceState(scan)).toBe(false);

      gh.files = [CHANGED, DOCS];
      const review = await newScan("pr_review");
      expect(await runSlice(review)).toBeUndefined();
      const reviewed = (await scanById(database, review))!;
      expect(reviewed).toMatchObject({ status: "completed", billing: "charged", creditsReserved: prReviewCredits(3), credits: prReviewCredits(3) });
      expect(reviewed.pricing).toEqual(TIERED);
      expect(autumn.get(orgId).credits).toBe(99_500 - prReviewCredits(3));
      expect(await scanBill(database, review)).toBeUndefined();
      expect(await orgCarry(database, orgId)).toBe(0);
    });
  });

  it("classic deep scans and PR reviews reserve and charge as before, priced classic", async () => {
    await withSettings({ SANDCHEST_ENGINE: "" }, async () => {
      autumn.get(orgId).credits = 100_000;
      // Not sized yet: the top tier is held, and what the engine measured is charged.
      const deep = await newScan();
      expect(await beginScan(deep)).toEqual({ state: "running" });
      expect(await scanById(database, deep)).toMatchObject({ billing: "reserved", creditsReserved: 2_500, pricing: { engine: "classic", mode: "tiered", unit: "cent" } });
      expect(autumn.get(orgId).credits).toBe(97_500);
      await database.$client`update scans set credits = 500, stats = ${JSON.stringify({ findingIds: [] })}::jsonb where id = ${deep}`;
      await publishScan(deep);
      expect(await scanById(database, deep)).toMatchObject({ status: "completed", billing: "charged", credits: 500 });
      expect(autumn.get(orgId).credits).toBe(99_500);

      gh.files = [CHANGED, DOCS];
      const review = await newScan("pr_review");
      expect(await beginScan(review)).toEqual({ state: "running" });
      expect(await scanById(database, review)).toMatchObject({ billing: "reserved", creditsReserved: prReviewCredits(3), pricing: { engine: "classic", mode: "tiered", unit: "cent" } });
      await database.$client`update scans set credits = ${prReviewCredits(3)}, stats = ${JSON.stringify({ findingIds: [] })}::jsonb where id = ${review}`;
      await publishScan(review);
      expect(await scanById(database, review)).toMatchObject({ status: "completed", billing: "charged", credits: prReviewCredits(3) });
      expect(autumn.get(orgId).credits).toBe(99_500 - prReviewCredits(3));
    });
  });

  it("Dig and a dashboard review hold their tier price as before, and store how they were priced", async () => {
    setScanStarter(async () => {});
    try {
      await withSettings({}, async () => {
        autumn.get(orgId).credits = 100_000;
        const dug = await requestDeepScan({ ...(await newRepo()), loc: 50_000 });
        expect(dug.ok).toBe(true);
        const dugId = (dug as { scanId: string }).scanId;
        expect(await scanById(database, dugId)).toMatchObject({ billing: "reserved", creditsReserved: 500, pricing: TIERED });

        gh.files = [CHANGED, DOCS];
        const repo = await newRepo();
        expect(await quotePrReview(repo, 7)).toMatchObject({ ok: true, credits: prReviewCredits(3) });
        const started = await startPrReview(repo, 7, prReviewCredits(3));
        expect(started).toMatchObject({ ok: true, credits: prReviewCredits(3) });
        const reviewId = (started as { scanId: string }).scanId;
        expect(await scanById(database, reviewId)).toMatchObject({ billing: "reserved", creditsReserved: prReviewCredits(3), pricing: TIERED });
        expect(autumn.get(orgId).credits).toBe(100_000 - 500 - prReviewCredits(3));
        await failScan(dugId, "test over");
        await failScan(reviewId, "test over");
        expect(autumn.get(orgId).credits).toBe(100_000);
      });
    } finally {
      setScanStarter(undefined);
    }
  });

  it("a scan keeps the engine it was reserved under when the setting changes before it starts", async () => {
    setScanStarter(async () => {});
    try {
      autumn.get(orgId).credits = 100_000;
      let onSlice = "";
      await withSettings({}, async () => {
        onSlice = (await requestDeepScan({ ...(await newRepo()), loc: 50_000 }) as { scanId: string }).scanId;
      });
      let onClassic = "";
      await withSettings({ SANDCHEST_ENGINE: "" }, async () => {
        onClassic = (await requestDeepScan({ ...(await newRepo()), loc: 50_000 }) as { scanId: string }).scanId;
        // Reserved on the slice engine: it stays there with the setting now classic.
        expect(await beginScan(onSlice)).toEqual({ state: "running", engine: "slice" });
      });
      await withSettings({}, async () => {
        expect(await beginScan(onClassic)).toEqual({ state: "running" });
      });
      expect((await scanById(database, onSlice))!.pricing).toMatchObject({ engine: "slice" });
      expect((await scanById(database, onClassic))!.pricing).toMatchObject({ engine: "classic" });
      await failScan(onSlice, "test over");
      await failScan(onClassic, "test over");
    } finally {
      setScanStarter(undefined);
    }
  });
});

describe.skipIf(!available)("usage billing in shadow", () => {
  it("the tier price is reserved and charged as today; a shadow bill is stored beside it, from no carry, and the carry is untouched", async () => {
    await withSettings(SHADOW_ENV, async () => {
      autumn.get(orgId).credits = 100_000;
      await resetCarry();
      await database.insert(schema.usageCarry).values({ orgId, carryMicroUsd: 7_000 });
      const scanId = await newScan();
      await runBilled(scanId, { state: "running", engine: "slice", pricing: "shadow" });

      const scan = (await scanById(database, scanId))!;
      expect(scan).toMatchObject({ status: "completed", billing: "charged", creditsReserved: 2_500, credits: 500 });
      expect(scan.pricing).toEqual({ engine: "slice", mode: "shadow", unit: "cent", multiplierThousandths: 3000, ceilingMicroUsd: 500_000, fast: false });
      expect(autumn.get(orgId).credits).toBe(99_500);

      // Every ledger row is billable here: one attempt of each step, all priced.
      const cost = await ledgerMicroUsd(scanId);
      const bill = (await scanBill(database, scanId))!;
      expect(bill).toMatchObject({ status: "shadow", reason: null, engine: "slice", fast: false, multiplierThousandths: 3000, creditMicroUsd: 10_000, costMicroUsd: cost, dueMicroUsd: cost * 3, carryInMicroUsd: 0 });
      // The cap a usage scan would have held: the ceiling times the multiplier, in whole credits: 0.5 USD × 3 in credits of a cent.
      expect(bill.reservedCredits).toBe(150);
      expect(bill.credits * 10_000 + bill.carryOutMicroUsd).toBe(bill.dueMicroUsd);
      expect(bill.lines.map((line) => line.kind).sort()).toContain("sandbox");
      expect(bill.lines.reduce((sum, line) => sum + line.costMicroUsd, 0)).toBe(cost);
      expect(await orgCarry(database, orgId)).toBe(7_000);
      await resetCarry();
    });
  });
});

describe.skipIf(!available)("usage billing on", () => {
  it("holds credits covering the ceiling times the multiplier, bills the ledger, charges the bill and carries the rest to the next scan", async () => {
    await withSettings(USAGE_ENV, async () => {
      autumn.get(orgId).credits = 10_000;
      await resetCarry();
      model.costUsd = 0.0012345;
      const first = await newScan();
      await runBilled(first, { state: "running", engine: "slice", pricing: "usage" });

      const scan = (await scanById(database, first))!;
      // 0.5 USD × 3 in credits of a cent.
      expect(scan.creditsReserved).toBe(150);
      expect(scan.pricing).toEqual({ engine: "slice", mode: "usage", unit: "cent", multiplierThousandths: 3000, ceilingMicroUsd: 500_000, fast: false });
      const bill = (await scanBill(database, first))!;
      expect(bill).toMatchObject({ status: "charged", settledAt: expect.any(Date), reason: null, creditMicroUsd: 10_000, multiplierThousandths: 3000, reservedCredits: 150, carryInMicroUsd: 0, capped: false });
      expect(bill.dueMicroUsd).toBe(bill.lines.reduce((sum, line) => sum + line.chargeMicroUsd, 0));
      expect(bill.credits * 10_000 + bill.carryOutMicroUsd).toBe(bill.dueMicroUsd);
      expect(bill.credits).toBeGreaterThan(0);
      expect(bill.credits).toBeLessThanOrEqual(150);
      expect(scan).toMatchObject({ status: "completed", billing: "charged", credits: bill.credits });
      expect(autumn.get(orgId).credits).toBe(10_000 - bill.credits);
      expect(autumn.get(orgId).locks.size).toBe(0);
      expect(await orgCarry(database, orgId)).toBe(bill.carryOutMicroUsd);

      // The next scan of the account starts from that carry.
      const second = await newScan();
      await runBilled(second, { state: "running", engine: "slice", pricing: "usage" });
      const next = (await scanBill(database, second))!;
      expect(next.carryInMicroUsd).toBe(bill.carryOutMicroUsd);
      expect(next.credits * 10_000 + next.carryOutMicroUsd).toBe(next.dueMicroUsd + next.carryInMicroUsd);
      expect(await orgCarry(database, orgId)).toBe(next.carryOutMicroUsd);
      expect(autumn.get(orgId).credits).toBe(10_000 - bill.credits - next.credits);
      await resetCarry();
    });
  });

  it("a pull request review holds for its own ceiling; one with nothing to review holds 0 and is billed 0", async () => {
    await withSettings(USAGE_ENV, async () => {
      autumn.get(orgId).credits = 10_000;
      await resetCarry();
      gh.files = [CHANGED, DOCS];
      const review = await newScan("pr_review");
      await runBilled(review, { state: "running", engine: "slice", pricing: "usage" });
      const scan = (await scanById(database, review))!;
      // 0.3 USD × 3 in credits of a cent.
      expect(scan).toMatchObject({ status: "completed", billing: "charged", creditsReserved: 90 });
      expect(scan.pricing).toMatchObject({ ceilingMicroUsd: 300_000 });
      const bill = (await scanBill(database, review))!;
      expect(bill).toMatchObject({ status: "charged", reservedCredits: 90 });
      expect(scan.credits).toBe(bill.credits);
      expect(autumn.get(orgId).credits).toBe(10_000 - bill.credits);

      await resetCarry();
      gh.files = [DOCS];
      const nothing = await newScan("pr_review");
      await runBilled(nothing, { state: "running", engine: "slice", pricing: "usage" });
      expect(await scanById(database, nothing)).toMatchObject({ status: "completed", creditsReserved: 0, credits: 0 });
      expect(await scanBill(database, nothing)).toMatchObject({ status: "charged", reservedCredits: 0, credits: 0, dueMicroUsd: 0, lines: [] });
      expect(autumn.get(orgId).credits).toBe(10_000 - bill.credits);

      // The dashboard quotes and holds the same.
      setScanStarter(async () => {});
      try {
        gh.files = [CHANGED, DOCS];
        const repo = await newRepo();
        expect(await quotePrReview(repo, 9)).toMatchObject({ ok: true, credits: 90 });
        const started = (await startPrReview(repo, 9, 90)) as { scanId: string };
        expect(await scanById(database, started.scanId)).toMatchObject({ billing: "reserved", creditsReserved: 90, pricing: { mode: "usage", ceilingMicroUsd: 300_000 } });
        const dug = (await requestDeepScan({ ...(await newRepo()), loc: 50_000 })) as { scanId: string };
        expect(await scanById(database, dug.scanId)).toMatchObject({ billing: "reserved", creditsReserved: 150, pricing: { mode: "usage", ceilingMicroUsd: 500_000 } });
        await failScan(started.scanId, "test over");
        await failScan(dug.scanId, "test over");
      } finally {
        setScanStarter(undefined);
      }
      await resetCarry();
    });
  });

  it("a bill over what was held is capped: the held credits are charged and the carry is left as it was", async () => {
    await withSettings(USAGE_ENV, async () => {
      autumn.get(orgId).credits = 10_000;
      await resetCarry();
      await database.insert(schema.usageCarry).values({ orgId, carryMicroUsd: 4_000 });
      // The sandbox's cost comes on top of the model calls the ceiling stopped at, so the review spends past it.
      model.costUsd = 0.02;
      gh.files = [CHANGED, DOCS];
      const review = await newScan("pr_review");
      await runBilled(review, { state: "running", engine: "slice", pricing: "usage" });
      const bill = (await scanBill(database, review))!;
      expect(bill).toMatchObject({ status: "charged", capped: true, credits: 90, reservedCredits: 90, carryInMicroUsd: 4_000, carryOutMicroUsd: 4_000 });
      expect(bill.dueMicroUsd).toBeGreaterThan(900_000);
      expect(await scanById(database, review)).toMatchObject({ status: "completed", billing: "charged", credits: 90 });
      expect(autumn.get(orgId).credits).toBe(10_000 - 90);
      expect(await orgCarry(database, orgId)).toBe(4_000);
      await resetCarry();
    });
  });

  it("an untrusted ledger is waived for each reason: nothing charged, the carry untouched, the reason reported", async () => {
    const cases: Array<{ reason: string; before?: () => Promise<void>; after?: (scanId: string) => Promise<void> }> = [
      {
        reason: "unpriced",
        after: async (scanId) => {
          await database.insert(schema.scanUsage).values({ scanId, kind: "model", stage: "verify", costUsd: "0", costSource: "provider", step: "verify", status: "unpriced" });
        },
      },
      {
        reason: "started",
        after: async (scanId) => {
          await database.insert(schema.scanUsage).values({ scanId, kind: "model", stage: "verify", costUsd: "0", costSource: "provider", step: "verify", status: "started", createdAt: new Date(Date.now() - 20 * 60_000) });
        },
      },
      {
        // The write-up's rows cannot be written: the ledger keeps trying, then counts them.
        reason: "unwritten",
        before: async () => {
          await database.$client.unsafe(`create function refuse_writeup_usage() returns trigger language plpgsql as $$ begin if new.step = 'writeup' then raise exception 'refused'; end if; return new; end $$`);
          await database.$client.unsafe(`create trigger refuse_writeup_usage before insert on scan_usage for each row execute function refuse_writeup_usage()`);
        },
        after: async () => {
          await database.$client.unsafe(`drop trigger refuse_writeup_usage on scan_usage; drop function refuse_writeup_usage()`);
        },
      },
      {
        reason: "sandbox_missing",
        before: async () => {
          host.usageFails = true;
        },
      },
    ];
    await withSettings(USAGE_ENV, async () => {
      for (const { reason, before, after } of cases) {
        autumn.get(orgId).credits = 10_000;
        await resetCarry();
        await database.insert(schema.usageCarry).values({ orgId, carryMicroUsd: 3_000 });
        const scanId = await newScan();
        await before?.();
        const reports = await withSentry(async () => {
          await throughWriteUp(scanId, { state: "running", engine: "slice", pricing: "usage" });
          await after?.(scanId);
          expect(await bill(scanId)).toEqual({ state: "billed", status: "waived", credits: 0 });
        });
        host.usageFails = false;
        // Reported with the scan and the reason only.
        expect(reports.filter((tags) => tags.reason !== undefined)).toEqual([expect.objectContaining({ source: "billing", scan_id: scanId, reason })]);
        const stored = (await scanBill(database, scanId))!;
        expect(stored).toMatchObject({ status: "waived", reason, credits: 0, capped: false, carryInMicroUsd: 3_000, carryOutMicroUsd: 3_000, reservedCredits: 150 });
        expect(stored.lines.length).toBeGreaterThan(0);
        if (reason === "unwritten") expect(Object.values(sliceState((await scanById(database, scanId))!).unwritten ?? {}).some((n) => n > 0)).toBe(true);
        expect((await scanById(database, scanId))!.credits).toBe(0);
        await publishSlice(scanId);
        expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "charged", credits: 0 });
        expect(autumn.get(orgId).credits).toBe(10_000);
        expect(await orgCarry(database, orgId)).toBe(3_000);
      }
      await resetCarry();
    });
  });

  it("a call still under way makes the bill step wait; its last poll bills the ledger as it is", async () => {
    await withSettings(USAGE_ENV, async () => {
      autumn.get(orgId).credits = 10_000;
      await resetCarry();
      const scanId = await newScan();
      await throughWriteUp(scanId, { state: "running", engine: "slice", pricing: "usage" });
      const id = await startUsageCall(database, scanId, { stage: "verify", role: "agent" });
      expect(await billSlice(scanId)).toEqual({ state: "waiting" });
      expect(await scanBill(database, scanId)).toBeUndefined();
      // The call ends: the next poll bills it.
      await finishUsageCall(database, id, { status: "ok", costUsd: "0.002" });
      expect(await billSlice(scanId)).toMatchObject({ state: "billed", status: "open" });
      await publishSlice(scanId);

      // One that never ends: the last poll bills the ledger as it is, untrusted.
      const stuck = await newScan();
      await throughWriteUp(stuck, { state: "running", engine: "slice", pricing: "usage" });
      await startUsageCall(database, stuck, { stage: "verify", role: "agent" });
      expect(await bill(stuck)).toEqual({ state: "billed", status: "waived", credits: 0 });
      expect(await scanBill(database, stuck)).toMatchObject({ reason: "started" });
      await publishSlice(stuck);
      expect(await scanById(database, stuck)).toMatchObject({ credits: 0, billing: "charged" });
      await resetCarry();
    });
  });

  it("the bill step run again changes nothing", async () => {
    await withSettings(USAGE_ENV, async () => {
      autumn.get(orgId).credits = 10_000;
      await resetCarry();
      const scanId = await newScan();
      await throughWriteUp(scanId, { state: "running", engine: "slice", pricing: "usage" });
      const once = await bill(scanId);
      const stored = await scanBill(database, scanId);
      const carry = await orgCarry(database, orgId);
      // A later write (here, the write-up run again would set the tier price) is put back to the bill's.
      await database.$client`update scans set credits = 5 where id = ${scanId}`;
      expect(await bill(scanId)).toEqual(once);
      expect(await scanBill(database, scanId)).toEqual(stored);
      expect(await orgCarry(database, orgId)).toBe(carry);
      expect((await scanById(database, scanId))!.credits).toBe(stored!.credits);
      await publishSlice(scanId);
      // Once published, it is left alone.
      expect(await billSlice(scanId)).toEqual({ state: "skipped" });
      expect(await scanBill(database, scanId)).toEqual({ ...stored!, status: "charged", settledAt: expect.any(Date) });
      await resetCarry();
    });
  });

  it("the multiplier, the credit, the mode and the ceiling are the scan's pricing, not settings changed mid-scan", async () => {
    autumn.get(orgId).credits = 10_000;
    await resetCarry();
    const scanId = await newScan();
    await withSettings(USAGE_ENV, async () => {
      expect(await beginScan(scanId)).toEqual({ state: "running", engine: "slice", pricing: "usage" });
    });
    // A ceiling the hunt would stop at, another multiplier, credits of a dollar, and only shadow billing.
    await withSettings({ SANDCHEST_USAGE_BILLING: "shadow", SANDCHEST_USAGE_MULTIPLIER: "7", NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: "dollar", SANDCHEST_SLICE_CEILING_USD: "0.0001" }, async () => {
      const { selected } = await huntSlice(scanId, { passDelayMs: 0 });
      expect(selected).toBe(2);
      expect(await session(scanId, "verify")).toBe(1);
      await session(scanId, "variants");
      await writeUpSlice(scanId);
      expect(tokensOf(scanId).map((claims) => claims!.ceilingMicroUsd)).toEqual([500_000, 500_000]);
      expect(await bill(scanId)).toMatchObject({ state: "billed", status: "open" });
      await publishSlice(scanId);
    });
    const stored = (await scanBill(database, scanId))!;
    expect(stored).toMatchObject({ status: "open", multiplierThousandths: 3000, creditMicroUsd: 10_000, reservedCredits: 150 });
    expect(stored.dueMicroUsd).toBe(stored.lines.reduce((sum, line) => sum + Math.round((line.costMicroUsd * 3000) / 1000), 0));
    // Published with credits of a dollar set: a bill in cents is not finalized until the setting matches it again.
    expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "reserved" });
    await withSettings(USAGE_ENV, () => sweepSettle(scanId));
    expect(await scanBill(database, scanId)).toMatchObject({ status: "charged" });
    expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "charged", credits: stored.credits });
    expect(autumn.get(orgId).credits).toBe(10_000 - stored.credits);
    await resetCarry();
  });

  it("the begin result carries the pricing mode only for slice scans billed from usage or in shadow", async () => {
    const settle = (scanId: string) => failScan(scanId, "test over");
    autumn.get(orgId).credits = 10_000;
    await withSettings({}, async () => {
      const scanId = await newScan();
      expect(await beginScan(scanId)).toEqual({ state: "running", engine: "slice" });
      await settle(scanId);
    });
    for (const [env, pricing] of [
      [SHADOW_ENV, "shadow"],
      [USAGE_ENV, "usage"],
    ] as const) {
      await withSettings(env, async () => {
        const deep = await newScan();
        expect(await beginScan(deep)).toEqual({ state: "running", engine: "slice", pricing });
        await settle(deep);
        // Recon and fix checks stay classic and tiered.
        const recon = await newScan("recon");
        const begun = await beginScan(recon);
        expect(begun).toEqual({ state: begun.state });
        expect((await scanById(database, recon))!.pricing).toMatchObject({ engine: "classic", mode: "tiered" });
        await settle(recon);
      });
    }
    // An account the slice engine does not take is classic, so tiered, with usage billing on.
    await withSettings({ ...USAGE_ENV, SANDCHEST_ENGINE_ORGS: "example-org" }, async () => {
      const outside = await newScan();
      expect(await beginScan(outside)).toEqual({ state: "running" });
      expect((await scanById(database, outside))!.pricing).toEqual({ engine: "classic", mode: "tiered", unit: "cent" });
      await settle(outside);
    });
  });
});

describe.skipIf(!available)("usage billing settlement", () => {
  type Finalize = Parameters<FakeAutumn["finalize"]>[0];

  /** Every finalize sent to Autumn while `fn` runs, failed ones included. */
  async function finalizes(fn: () => Promise<unknown>): Promise<Finalize[]> {
    const seen: Finalize[] = [];
    const original = autumn.finalize;
    autumn.finalize = (input) => {
      seen.push(input);
      return original.call(autumn, input);
    };
    try {
      await fn();
    } finally {
      autumn.finalize = original;
    }
    return seen;
  }

  /** A usage scan through its bill step, the account's carry at `carry` before it. */
  async function billedScan(carry = 3_000) {
    autumn.get(orgId).credits = 10_000;
    await resetCarry();
    await database.insert(schema.usageCarry).values({ orgId, carryMicroUsd: carry });
    const scanId = await newScan();
    await throughWriteUp(scanId, { state: "running", engine: "slice", pricing: "usage" });
    await bill(scanId);
    return { scanId, bill: (await scanBill(database, scanId))! };
  }

  const reasons = (reports: Array<Record<string, unknown>>) => reports.filter((tags) => tags.reason !== undefined);

  it("Autumn failing at publish leaves the bill open and the scan reserved; the sweep charges the bill's credits once and the carry never moves again", async () => {
    await withSettings(USAGE_ENV, async () => {
      const { scanId, bill: open } = await billedScan();
      expect(open).toMatchObject({ status: "open", settledAt: null });
      expect(open.credits).toBeGreaterThan(0);
      expect(open.credits).toBeLessThan(150);
      const carry = await orgCarry(database, orgId);
      expect(carry).toBe(open.carryOutMicroUsd);

      autumn.failNext.add("finalize");
      expect(await finalizes(() => publishSlice(scanId))).toHaveLength(1);
      expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "reserved" });
      expect(await scanBill(database, scanId)).toEqual(open);
      expect(autumn.get(orgId).locks.get(scanId)).toBe(150);
      expect(await orgCarry(database, orgId)).toBe(carry);

      // The sweep confirms exactly the bill's credits, and marks the scan and the bill together.
      expect(await finalizes(() => sweepSettle(scanId))).toEqual([{ customerId: orgId, lockId: scanId, action: "confirm", credits: open.credits }]);
      expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "charged", credits: open.credits });
      const charged = (await scanBill(database, scanId))!;
      expect(charged).toEqual({ ...open, status: "charged", settledAt: expect.any(Date) });
      expect(autumn.get(orgId).credits).toBe(10_000 - open.credits);
      expect(autumn.get(orgId).locks.has(scanId)).toBe(false);
      expect(await orgCarry(database, orgId)).toBe(carry);

      // A second sweep, and the publish step run again, change nothing.
      expect(
        await finalizes(async () => {
          await sweepSettle(scanId);
          await publishSlice(scanId);
        }),
      ).toEqual([]);
      expect(await scanBill(database, scanId)).toEqual(charged);
      expect(autumn.get(orgId).credits).toBe(10_000 - open.credits);
      expect(await orgCarry(database, orgId)).toBe(carry);
      await resetCarry();
    });
  });

  it("a usage scan with no bill when it is charged: nothing charged, the hold released, reported once, the scan still completed", async () => {
    await withSettings(USAGE_ENV, async () => {
      autumn.get(orgId).credits = 10_000;
      await resetCarry();
      const scanId = await newScan();
      await throughWriteUp(scanId, { state: "running", engine: "slice", pricing: "usage" });
      let calls: Finalize[] = [];
      const reports = await withSentry(async () => {
        calls = await finalizes(async () => {
          await publishSlice(scanId);
          await sweepSettle(scanId);
        });
      });
      expect(calls).toEqual([{ customerId: orgId, lockId: scanId, action: "release" }]);
      expect(reasons(reports)).toEqual([expect.objectContaining({ source: "billing", scan_id: scanId, reason: "no_bill" })]);
      expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "released", credits: 0 });
      expect(await scanBill(database, scanId)).toBeUndefined();
      expect(autumn.get(orgId).credits).toBe(10_000);
      expect(await orgCarry(database, orgId)).toBe(0);
    });
  });

  it("a waived bill: its hold is released whether the scan completes or fails, and it stays waived, settled", async () => {
    await withSettings(USAGE_ENV, async () => {
      for (const ending of ["published", "failed"] as const) {
        autumn.get(orgId).credits = 10_000;
        await resetCarry();
        await database.insert(schema.usageCarry).values({ orgId, carryMicroUsd: 3_000 });
        const scanId = await newScan();
        await throughWriteUp(scanId, { state: "running", engine: "slice", pricing: "usage" });
        await database.insert(schema.scanUsage).values({ scanId, kind: "model", stage: "verify", costUsd: "0", costSource: "provider", step: "verify", status: "unpriced" });
        expect(await bill(scanId)).toEqual({ state: "billed", status: "waived", credits: 0 });
        const waived = (await scanBill(database, scanId))!;
        expect(waived.settledAt).toBeNull();

        const calls = await finalizes(() => (ending === "published" ? publishSlice(scanId) : failScan(scanId, "test over")));
        expect(calls).toEqual([{ customerId: orgId, lockId: scanId, action: "release" }]);
        expect(await scanBill(database, scanId)).toEqual({ ...waived, settledAt: expect.any(Date) });
        expect(await scanById(database, scanId)).toMatchObject(ending === "published" ? { status: "completed", billing: "charged", credits: 0 } : { status: "failed", billing: "released", credits: 0 });
        expect(autumn.get(orgId).credits).toBe(10_000);
        expect(await orgCarry(database, orgId)).toBe(3_000);
      }
      await resetCarry();
    });
  });

  it("a scan that fails after its bill was written voids it and gives the carry back exactly, once, however often the fail runs", async () => {
    await withSettings(USAGE_ENV, async () => {
      const { scanId, bill: open } = await billedScan(3_000);
      expect(await orgCarry(database, orgId)).toBe(open.carryOutMicroUsd);
      await failScan(scanId, "test over");
      const voided = (await scanBill(database, scanId))!;
      expect(voided).toEqual({ ...open, status: "voided", reason: "scan_failed" });
      expect(await scanById(database, scanId)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
      expect(autumn.get(orgId).credits).toBe(10_000);
      expect(await orgCarry(database, orgId)).toBe(3_000);

      // The fail step run again, after a later bill moved the carry: nothing more is given back.
      await database.$client`update usage_carry set carry_micro_usd = 5000 where org_id = ${orgId}`;
      await failScan(scanId, "test over");
      expect(await scanBill(database, scanId)).toEqual(voided);
      expect(await orgCarry(database, orgId)).toBe(5_000);
      await resetCarry();
    });
  });

  it("a release Autumn refuses in the fail step leaves the bill open until the sweep releases it, then voids it once", async () => {
    await withSettings(USAGE_ENV, async () => {
      const { scanId, bill: open } = await billedScan(3_000);
      autumn.failNext.add("finalize");
      await failScan(scanId, "The scan stopped responding.");
      expect(await scanById(database, scanId)).toMatchObject({ status: "failed", billing: "reserved" });
      expect(await scanBill(database, scanId)).toEqual(open);
      expect(await orgCarry(database, orgId)).toBe(open.carryOutMicroUsd);

      expect(await finalizes(() => sweepSettle(scanId))).toEqual([{ customerId: orgId, lockId: scanId, action: "release" }]);
      expect(await scanById(database, scanId)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
      expect(await scanBill(database, scanId)).toEqual({ ...open, status: "voided", reason: "scan_failed" });
      expect(autumn.get(orgId).credits).toBe(10_000);
      expect(await orgCarry(database, orgId)).toBe(3_000);

      expect(await finalizes(() => sweepSettle(scanId))).toEqual([]);
      expect(await orgCarry(database, orgId)).toBe(3_000);
      await resetCarry();
    });
  });

  it("a scan failed after its charge went through stays charged: its bill is not voided and the carry stays", async () => {
    await withSettings(USAGE_ENV, async () => {
      const { scanId, bill: open } = await billedScan(3_000);
      await publishSlice(scanId);
      const charged = (await scanBill(database, scanId))!;
      expect(charged.status).toBe("charged");
      const carry = await orgCarry(database, orgId);
      expect(await finalizes(() => failScan(scanId, "test over"))).toEqual([]);
      expect(await scanBill(database, scanId)).toEqual(charged);
      expect(await scanById(database, scanId)).toMatchObject({ billing: "charged", credits: open.credits });
      expect(autumn.get(orgId).credits).toBe(10_000 - open.credits);
      expect(await orgCarry(database, orgId)).toBe(carry);
      await resetCarry();
    });
  });

  it("a bill in another credit than the setting's is not finalized and is reported; it is charged once the setting matches", async () => {
    let scanId = "";
    let open: Awaited<ReturnType<typeof billedScan>>["bill"] | undefined;
    await withSettings(USAGE_ENV, async () => {
      ({ scanId, bill: open } = await billedScan());
    });
    // Usage billing off and credits of a dollar: the scan's pricing still says usage, its bill is in cents.
    await withSettings({ NEXT_PUBLIC_SANDCHEST_CREDIT_UNIT: "dollar" }, async () => {
      let calls: Finalize[] = [];
      const reports = await withSentry(async () => {
        calls = await finalizes(async () => {
          await publishSlice(scanId);
          await sweepSettle(scanId);
        });
      });
      expect(calls).toEqual([]);
      expect(reasons(reports)).toContainEqual(expect.objectContaining({ source: "billing", scan_id: scanId, reason: "credit_unit" }));
      expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "reserved" });
      expect(await scanBill(database, scanId)).toEqual(open);
      expect(autumn.get(orgId).locks.get(scanId)).toBe(150);
    });
    await withSettings(USAGE_ENV, async () => {
      await sweepSettle(scanId);
      expect(await scanById(database, scanId)).toMatchObject({ billing: "charged", credits: open!.credits });
      expect(autumn.get(orgId).credits).toBe(10_000 - open!.credits);
      await resetCarry();
    });
  });

  it("a hold older than its lifetime is reported and noted on the bill before it is confirmed", async () => {
    await withSettings(USAGE_ENV, async () => {
      const { scanId, bill: open } = await billedScan();
      await database.$client`update scans set created_at = now() - interval '7 hours' where id = ${scanId}`;
      const reports = await withSentry(() => publishSlice(scanId));
      expect(reasons(reports)).toEqual([expect.objectContaining({ source: "billing", scan_id: scanId, reason: "hold_expired" })]);
      expect(await scanBill(database, scanId)).toEqual({ ...open, status: "charged", reason: "hold_expired", settledAt: expect.any(Date) });
      expect(await scanById(database, scanId)).toMatchObject({ billing: "charged", credits: open.credits });
      await resetCarry();
    });
  });

  it("a shadow bill is never settled, voided or charged, and the carry is untouched", async () => {
    await withSettings(SHADOW_ENV, async () => {
      autumn.get(orgId).credits = 100_000;
      await resetCarry();
      await database.insert(schema.usageCarry).values({ orgId, carryMicroUsd: 7_000 });
      const published = await newScan();
      await runBilled(published, { state: "running", engine: "slice", pricing: "shadow" });
      expect(await scanBill(database, published)).toMatchObject({ status: "shadow", reason: null, settledAt: null });

      const failed = await newScan();
      await throughWriteUp(failed, { state: "running", engine: "slice", pricing: "shadow" });
      await bill(failed);
      const stored = await scanBill(database, failed);
      await failScan(failed, "test over");
      expect(await scanBill(database, failed)).toEqual(stored);
      expect(await scanById(database, failed)).toMatchObject({ status: "failed", billing: "released" });
      expect(autumn.get(orgId).credits).toBe(99_500);
      expect(await orgCarry(database, orgId)).toBe(7_000);
      await resetCarry();
    });
  });
});

describe.skipIf(!available)("the slice engine's daily limit", () => {
  const CLASSIC = { engine: "classic", mode: "tiered", unit: "cent" } as const;

  /** Runs `fn` with usage billing as `env` sets it (on unless given) and the limit set, every read forgotten before and after. */
  async function withLimit(limit: string, fn: () => Promise<void>, env: Record<string, string> = USAGE_ENV): Promise<void> {
    resetSliceLimit();
    try {
      await withSettings({ ...env, SANDCHEST_SLICE_DAILY_LIMIT_USD: limit }, fn);
    } finally {
      resetSliceLimit();
    }
  }

  /** Something spent in the last 24 hours, so a made-up tiny limit is reached. */
  async function spend(): Promise<void> {
    await insertUsage(database, await newScan("recon"), [{ kind: "model", stage: "recon", costUsd: "0.01", costSource: "provider" }]);
  }

  const reserves = () => autumn.calls.filter((call) => call === "reserve").length;

  it("reached with usage billing off or in shadow: scans priced now get the classic engine at every reservation and in begin; scans already priced keep slice", async () => {
    setScanStarter(async () => {});
    try {
      for (const [env, mode] of [[{}, "tiered"], [SHADOW_ENV, "shadow"]] as const) {
        autumn.get(orgId).credits = 10_000;
        // Priced on slice under the limit, before it is reached.
        let priced = "";
        await withLimit(
          "999999",
          async () => {
            priced = ((await requestDeepScan({ ...(await newRepo()), loc: 50_000 })) as { scanId: string }).scanId;
            expect((await scanById(database, priced))!.pricing).toMatchObject({ engine: "slice", mode });
          },
          env,
        );
        await spend();
        await withLimit(
          "0.000001",
          async () => {
            // Dig.
            const dug = await requestDeepScan({ ...(await newRepo()), loc: 50_000 });
            expect(dug).toMatchObject({ ok: true });
            expect("heldUpTo" in dug).toBe(false);
            const dugId = (dug as { scanId: string }).scanId;
            expect((await scanById(database, dugId))!.pricing).toEqual(CLASSIC);

            // A dashboard review: quoted and held as classic.
            gh.files = [CHANGED, DOCS];
            const repo = await newRepo();
            const quoted = await quotePrReview(repo, 7);
            expect(quoted).toMatchObject({ ok: true });
            expect("upTo" in quoted).toBe(false);
            const started = await startPrReview(repo, 7, (quoted as { credits: number }).credits);
            expect(started).toMatchObject({ ok: true });
            const reviewId = (started as { scanId: string }).scanId;
            expect((await scanById(database, reviewId))!.pricing).toEqual(CLASSIC);

            // Begin, for scans with no stored pricing: a deep scan and a review from a push.
            const deep = await newScan();
            expect(await beginScan(deep)).toEqual({ state: "running" });
            expect((await scanById(database, deep))!.pricing).toEqual(CLASSIC);
            const pushed = await newScan("pr_review");
            expect(await beginScan(pushed)).toEqual({ state: "running" });
            expect((await scanById(database, pushed))!.pricing).toEqual(CLASSIC);
            // A scheduled deep scan: started and held as classic, as before.
            const scheduled = await requestDeepScan({ ...(await newRepo()), loc: 50_000 }, "schedule", { headSha: "HEAD" });
            expect(scheduled).toMatchObject({ ok: true });
            const scheduledId = (scheduled as { scanId: string }).scanId;
            expect((await scanById(database, scheduledId))!.pricing).toEqual(CLASSIC);
            for (const id of [dugId, reviewId, deep, pushed, scheduledId]) await failScan(id, "test over");

            // Priced before the limit was reached: it stays on slice, billed as it was priced.
            expect(await beginScan(priced)).toEqual({ state: "running", engine: "slice", ...(mode === "shadow" && { pricing: "shadow" }) });
            await failScan(priced, "test over");
          },
          env,
        );
      }
    } finally {
      setScanStarter(undefined);
    }
  });

  it("reached under usage billing: a person's deep scan and dashboard review are refused, holding nothing and leaving nothing behind", async () => {
    await spend();
    autumn.get(orgId).credits = 10_000;
    await withLimit("0.000001", async () => {
      const before = reserves();
      const repo = await newRepo();
      expect(await requestDeepScan({ ...repo, loc: 50_000 })).toEqual({ ok: false, reason: "paused" });
      gh.files = [CHANGED, DOCS];
      expect(await quotePrReview(repo, 7)).toEqual({ ok: false, reason: "paused" });
      expect(await startPrReview(repo, 7, 90)).toEqual({ ok: false, reason: "paused" });
      // A review with nothing to review holds nothing, so it is quoted as before.
      gh.files = [DOCS];
      expect(await quotePrReview(repo, 8)).toEqual({ ok: true, scanId: "", credits: 0 });
      expect(await database.$client`select id from scans where repo_id = ${repo.id}`).toHaveLength(0);
      expect(reserves()).toBe(before);
    });
  });

  it("reached under usage billing: a review from a push and a scheduled deep scan wait, queued with one note and holding nothing, then go ahead once it clears", async () => {
    setScanStarter(async () => {});
    try {
      await spend();
      autumn.get(orgId).credits = 10_000;
      gh.files = [CHANGED, DOCS];
      const pushed = await newScan("pr_review");
      let scheduled = "";
      await withLimit("0.000001", async () => {
        const before = reserves();
        const result = await requestDeepScan({ ...(await newRepo()), loc: 50_000 }, "schedule", { headSha: "HEAD" });
        expect(result).toMatchObject({ ok: true });
        expect("heldUpTo" in result).toBe(false);
        scheduled = (result as { scanId: string }).scanId;
        for (const id of [pushed, scheduled]) {
          expect(await beginScan(id)).toEqual({ state: "queued" });
          expect(await beginScan(id)).toEqual({ state: "queued" });
          expect(await scanById(database, id)).toMatchObject({ status: "queued", billing: null, creditsReserved: null, pricing: null });
          expect((await feedOf(id)).filter((message) => message === PAUSED_WAIT)).toHaveLength(1);
        }
        expect(reserves()).toBe(before);
      });
      // The limit no longer reached: each goes ahead by itself, priced and held as any other.
      await withLimit("999999", async () => {
        for (const id of [pushed, scheduled]) expect(await beginScan(id)).toEqual({ state: "running", engine: "slice", pricing: "usage" });
        expect(await scanById(database, pushed)).toMatchObject({ billing: "reserved", creditsReserved: 90, pricing: { engine: "slice", mode: "usage" } });
        expect(await scanById(database, scheduled)).toMatchObject({ billing: "reserved", creditsReserved: 150, pricing: { engine: "slice", mode: "usage" } });
      });
      for (const id of [pushed, scheduled]) await failScan(id, "test over");
    } finally {
      setScanStarter(undefined);
    }
  });

  it("reached with billing off: begin runs a scan with no pricing on the classic engine", async () => {
    await spend();
    setAutumn(undefined);
    try {
      await withLimit("0.000001", async () => {
        const deep = await newScan();
        expect(await beginScan(deep)).toEqual({ state: "running" });
        expect((await scanById(database, deep))!.pricing).toBeNull();
        await failScan(deep, "test over");
      });
    } finally {
      setAutumn(autumn);
    }
  });

  it("under the limit, and unset: scans run on slice as before", async () => {
    autumn.get(orgId).credits = 10_000;
    for (const limit of ["999999", ""]) {
      await withLimit(limit, async () => {
        const deep = await newScan();
        expect(await beginScan(deep)).toEqual({ state: "running", engine: "slice", pricing: "usage" });
        await failScan(deep, "test over");
      });
    }
  });
});

// ---- Two verification sessions ----------------------------------------------------

/** The hunt's result as the sandbox keeps it. */
const huntOf = async (scanId: string) => JSON.parse((await sandboxOf(scanId)).private.get("slice-hunt.json")!) as { findings: slice.FindingsEntry[] };
/** One of the sandbox's private files, parsed; undefined when there is none. */
async function kept<T>(scanId: string, name: string): Promise<T | undefined> {
  const text = (await sandboxOf(scanId)).private.get(name);
  return text === undefined ? undefined : (JSON.parse(text) as T);
}
/** The fake sessions of a scan, in the order they started. */
const sessionsOf = (scanId: string) => [...host.sessions.values()].filter((s) => verifyGatewayToken(s.token, SECRET)?.scanId === scanId);
const idsOf = (entries: unknown[]) => (entries as Array<{ id: string }>).map((entry) => entry.id);
const fromTo = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `F${from + i}`);
/** Where each of the scan's findings lands, sorted. */
async function findingSinks(scanId: string): Promise<string[]> {
  const { findingIds } = (await scanById(database, scanId))!.stats as { findingIds: string[] };
  const found = findingIds.length ? await database.query.findings.findMany({ where: (f, { inArray }) => inArray(f.id, findingIds) }) : [];
  return found.map((f) => (f.attackPath as Array<{ file: string; line: number }>).at(-1)!).map((at) => `${at.file}:${at.line}`).sort();
}
const verifyStages = async (scanId: string) => (await stagesOf(scanId)).filter((s) => s.stage.startsWith("verify")).map((s) => [s.stage, s.attempt, s.ended, s.outcome]);
/** The agent's ledger rows of one step: what the gateway recorded under that session's token. */
const agentRows = async (scanId: string, step: string) => (await usage(scanId)).filter((r) => r.step === step).map((r) => [r.kind, r.stage, r.role, r.attempt, r.status, r.costUsd]);

/** A deep scan, begun and hunted, whose hunt selected `extra + 2` candidates. */
async function hunted(extra: number, expected: BeginResult = { state: "running", engine: "slice" }) {
  host.extraFiles = extra;
  const scanId = await newScan();
  expect(await beginScan(scanId)).toEqual(expected);
  const result = await huntSlice(scanId, { passDelayMs: 0 });
  return { scanId, result, findings: (await huntOf(scanId)).findings };
}

describe.skipIf(!available)("two verification sessions", () => {
  it("a hunt that selects 45 is verified by two sessions at the same time, each under its own stage, and the bill counts both", async () => {
    await withSettings(USAGE_ENV, async () => {
      autumn.get(orgId).credits = 10_000;
      await resetCarry();
      const { scanId, result, findings } = await hunted(43, { state: "running", engine: "slice", pricing: "usage" });
      // The second session takes the variants session's place.
      expect(result).toEqual({ selected: 45, variants: false, secondBand: true });
      expect(idsOf(findings)).toEqual(fromTo(1, 45));
      // The agent may reach the two relays, and nothing else.
      const sandbox = await sandboxOf(scanId);
      expect(sandbox.setup).toContain(`LOOPBACK_PORTS='${RELAY_PORT} ${SECOND_RELAY_PORT}'`);
      expect(sandbox.setup).toContain("ALLOW_HOSTS=''");
      expect(sandbox.setup).toContain("DNS='no'");

      // One real candidate in each band.
      host.realSinks = [findings[2]!.sink, findings[40]!.sink];
      host.log = [];
      expect(await sessions(scanId, ["verify", "verify2"])).toBe(2);
      // Both were under way before either was collected.
      expect(host.log).toEqual(["start:verify", "start:verify2", "collect:verify", "collect:verify2"]);
      const [first, second] = sessionsOf(scanId);
      expect(first).toMatchObject({ kind: "refute", port: RELAY_PORT, stopped: true, collected: 1 });
      expect(first!.slot).toBeUndefined();
      expect(first!.findings).toEqual(findings.slice(0, 30));
      expect(second).toMatchObject({ kind: "refute", slot: "band2", port: SECOND_RELAY_PORT, stopped: true, collected: 1 });
      expect(second!.findings).toEqual(findings.slice(30));
      // Each token has its own stage and its own attempt of it, under the scan's one ceiling.
      expect(tokensOf(scanId)).toMatchObject([
        { scanId, stage: "verify", attempt: 0, ceilingMicroUsd: 500_000 },
        { scanId, stage: "verify2", attempt: 0, ceilingMicroUsd: 500_000 },
      ]);

      // Counted per session; the verdicts of each kept, and the confirmed findings of both in rank order.
      const state = sliceState((await scanById(database, scanId))!);
      expect(state.sessions!.verify).toMatchObject({ attempt: 0, collected: true, verdicts: 30, real: 1 });
      expect("slot" in state.sessions!.verify!).toBe(false);
      expect(state.sessions!.verify2).toMatchObject({ slot: "band2", attempt: 0, collected: true, verdicts: 15, real: 1 });
      expect(idsOf((await kept<slice.Verdict[]>(scanId, "slice-verify.json"))!)).toEqual(fromTo(1, 30));
      expect(idsOf((await kept<slice.Verdict[]>(scanId, "slice-verify2.json"))!)).toEqual(fromTo(31, 45));
      expect(idsOf((await kept<slice.ConfirmedEntry[]>(scanId, "slice-confirmed.json"))!)).toEqual(["F3", "F41"]);

      // Both are written up, and no variants session ran.
      await verifyThenVariants(scanId, result);
      expect(sessionsOf(scanId).map((s) => s.kind)).toEqual(["refute", "refute"]);
      expect(await writeUpSlice(scanId)).toEqual({ findings: 2 });
      expect(await findingSinks(scanId)).toEqual([...host.realSinks].sort());
      // Made, then kept alive once for each session started.
      expect(sandbox.ttl).toEqual([5400, 5400, 5400]);

      // The ledger: each session's calls under its own step.
      expect(await agentRows(scanId, "verify")).toEqual([["model", "verify", "agent", 0, "ok", "0.0020000000"]]);
      expect(await agentRows(scanId, "verify2")).toEqual([["model", "verify2", "agent", 0, "ok", "0.0030000000"]]);

      // The bill counts every row, the second session's as much as the first's, and shows the two as one line.
      expect(await bill(scanId)).toMatchObject({ state: "billed", status: "open" });
      const stored = (await scanBill(database, scanId))!;
      expect(stored.costMicroUsd).toBe(await ledgerMicroUsd(scanId));
      expect(stored.dueMicroUsd).toBe(stored.costMicroUsd * 3);
      expect(stored.lines.filter((line) => line.stage.startsWith("verify")).map((line) => [line.kind, line.stage, line.requests, line.costMicroUsd, line.chargeMicroUsd])).toEqual([
        ["model", "verify2", 1, 3_000, 9_000],
        ["model", "verify", 1, 2_000, 6_000],
      ]);
      const view = billView(stored)!;
      expect(view.groups.filter((group) => group.label === "Verifying in a sandbox")).toEqual([{ kind: "model", label: "Verifying in a sandbox", calls: 2, inputTokens: 100, outputTokens: 10, credits: 150 }]);
      expect(view.groups.map((group) => group.label)).not.toContain("Other analysis");
      expect(view.usage).toBe(Math.round(stored.dueMicroUsd / 100));

      await publishSlice(scanId);
      expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "charged", credits: stored.credits });
      expect(autumn.get(orgId).credits).toBe(10_000 - stored.credits);

      // Each session is a stage of its own, started and ended.
      expect((await stagesOf(scanId)).map((s) => [s.stage, s.attempt, s.ended, s.outcome])).toEqual([
        ["queue", 0, true, "ok"],
        ["sandbox", 0, true, "ok"],
        ["select", 0, true, "ok"],
        ["hunt", 0, true, "ok"],
        ["score", 0, true, "ok"],
        ["verify", 0, true, "ok"],
        ["verify2", 0, true, "ok"],
        ["writeup", 0, true, "ok"],
        ["publish", 0, true, "ok"],
      ]);
      // The feed names the whole verification once when it starts and once when it is in, and no code.
      const feed = await feedOf(scanId);
      expect(feed.filter((message) => message.startsWith("Verifying"))).toEqual(["Verifying 45 candidates against the code in the sandbox…"]);
      expect(feed.filter((message) => message.startsWith("Verified"))).toEqual(["Verified 45: 2 confirmed."]);
      expect(feed.filter((message) => message.includes("second verification"))).toEqual([]);
      for (const message of feed) expect(message).not.toContain("req.params");
      await resetCarry();
    });
  });

  it("a hunt that selects 30 or fewer is verified by one session, exactly as before", async () => {
    const { scanId, result } = await hunted(28);
    expect(result).toEqual({ selected: 30, variants: true, secondBand: false });
    // Asked for all the same, a second session has nothing to rule on and does not start.
    expect(await startSliceSession(scanId, "verify2")).toEqual({ started: false });
    expect(host.started).toEqual([]);
    await verifyThenVariants(scanId, result);
    expect(await writeUpSlice(scanId)).toEqual({ findings: 1 });
    await publishSlice(scanId);

    expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "charged", credits: 500 });
    expect(sessionsOf(scanId).map((s) => [s.kind, s.slot, s.port, s.findings.length])).toEqual([
      ["refute", undefined, RELAY_PORT, 30],
      ["variants", undefined, RELAY_PORT, 1],
    ]);
    expect(tokensOf(scanId).map((claims) => [claims!.stage, claims!.attempt])).toEqual([
      ["verify", 0],
      ["variants", 0],
    ]);
    const state = sliceState((await scanById(database, scanId))!);
    expect(Object.keys(state.sessions!)).toEqual(["verify", "variants"]);
    expect(Object.keys(state.sessions!.verify!).sort()).toEqual(["agentProcessId", "attempt", "collected", "real", "relayProcessId", "startedAt", "verdicts"]);
    const sandbox = await sandboxOf(scanId);
    expect([...sandbox.private.keys()].filter((name) => name.startsWith("slice-")).sort()).toEqual(["slice-confirmed.json", "slice-hunt.json", "slice-variants.json", "slice-verify.json"]);
    expect(sandbox.ttl).toEqual([5400, 5400, 5400]);
    expect(await verifyStages(scanId)).toEqual([["verify", 0, true, "ok"]]);
    expect((await usage(scanId)).filter((r) => r.step === "verify2" || r.stage === "verify2")).toEqual([]);
    const feed = await feedOf(scanId);
    expect(feed.filter((message) => message.startsWith("Verif"))).toEqual(["Verifying 30 candidates against the code in the sandbox…", "Verified 30: 1 confirmed."]);
  });

  it("a second session that cannot start, fails, leaves no verdicts or cannot be read does not fail the scan: the first's findings are written up, and the scan is billed for what its ledger holds", async () => {
    const NO_VERDICTS = "The second verification session left no verdicts; carrying on with the first.";
    const cases: Array<{ second: SecondOutcome; says: string; stage: string; spent: boolean; recorded: Record<string, unknown> | undefined }> = [
      { second: "throw", says: "Could not start the second verification session; carrying on with the first.", stage: "failed", spent: false, recorded: undefined },
      { second: "fail", says: NO_VERDICTS, stage: "failed", spent: true, recorded: { slot: "band2", collected: true, verdicts: 0, real: 0 } },
      { second: "empty", says: NO_VERDICTS, stage: "ok", spent: true, recorded: { slot: "band2", collected: true, verdicts: 0, real: 0 } },
      { second: "unreadable", says: "The second verification session could not be read; carrying on with the first.", stage: "ok", spent: true, recorded: { slot: "band2" } },
    ];
    await withSettings(USAGE_ENV, async () => {
      for (const { second, says, stage, spent, recorded } of cases) {
        host.reset();
        autumn.get(orgId).credits = 10_000;
        await resetCarry();
        const { scanId, result, findings } = await hunted(43, { state: "running", engine: "slice", pricing: "usage" });
        // One real candidate in each band: the second band's is never ruled on.
        host.realSinks = [findings[2]!.sink, findings[40]!.sink];
        host.second = second;
        await verifyThenVariants(scanId, result);
        expect(await writeUpSlice(scanId)).toEqual({ findings: 1 });
        expect(await findingSinks(scanId)).toEqual([findings[2]!.sink]);

        const state = sliceState((await scanById(database, scanId))!);
        expect(state.sessions!.verify).toMatchObject({ collected: true, verdicts: 30, real: 1 });
        if (recorded) expect(state.sessions!.verify2).toMatchObject(recorded);
        else expect(state.sessions!.verify2).toBeUndefined();
        if (second === "unreadable") expect(state.sessions!.verify2!.collected).toBeUndefined();
        expect(await verifyStages(scanId)).toEqual([
          ["verify", 0, true, "ok"],
          ["verify2", 0, true, stage],
        ]);
        // No variants session follows a scan with a second band, whatever became of it.
        expect(sessionsOf(scanId).map((s) => s.kind)).not.toContain("variants");
        const feed = await feedOf(scanId);
        expect(feed.filter((message) => message.includes("second verification"))).toEqual([says]);
        expect(feed.filter((message) => message.startsWith("Verif"))).toEqual(["Verifying 45 candidates against the code in the sandbox…", "Verified 30: 1 confirmed."]);

        // Billed from the ledger as it is: what the second session spent before it ended is in it.
        expect(await agentRows(scanId, "verify2")).toEqual(spent ? [["model", "verify2", "agent", 0, "ok", "0.0030000000"]] : []);
        expect(await bill(scanId)).toMatchObject({ state: "billed", status: "open" });
        const stored = (await scanBill(database, scanId))!;
        expect(stored.costMicroUsd).toBe(await ledgerMicroUsd(scanId));
        expect(stored.lines.filter((line) => line.stage === "verify2").map((line) => line.costMicroUsd)).toEqual(spent ? [3_000] : []);
        await publishSlice(scanId);
        expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "charged", credits: stored.credits });
        expect(autumn.get(orgId).credits).toBe(10_000 - stored.credits);
      }
      await resetCarry();
    });
  });

  it("a second session that runs out of time is stopped, and the verdicts it had reached are kept", async () => {
    const { scanId, result, findings } = await hunted(43);
    // It rules on its first five candidates (F31 to F35) and never ends. F33 and F41 are real; only F33 is reached.
    host.second = "cut";
    host.realSinks = [findings[2]!.sink, findings[32]!.sink, findings[40]!.sink];
    await verifyThenVariants(scanId, result);
    const second = sessionsOf(scanId)[1]!;
    expect(second).toMatchObject({ slot: "band2", stopped: true, collected: 1 });
    expect(second.polls).toBe(5);
    expect(sliceState((await scanById(database, scanId))!).sessions!.verify2).toMatchObject({ collected: true, verdicts: 5, real: 1 });
    expect(idsOf((await kept<slice.Verdict[]>(scanId, "slice-verify2.json"))!)).toEqual(fromTo(31, 35));
    expect(idsOf((await kept<slice.ConfirmedEntry[]>(scanId, "slice-confirmed.json"))!)).toEqual(["F3", "F33"]);
    expect(await verifyStages(scanId)).toEqual([
      ["verify", 0, true, "ok"],
      ["verify2", 0, true, "failed"],
    ]);
    expect(await writeUpSlice(scanId)).toEqual({ findings: 2 });
    expect(await findingSinks(scanId)).toEqual([findings[2]!.sink, findings[32]!.sink].sort());
    await publishSlice(scanId);
    expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "charged" });
    const feed = await feedOf(scanId);
    expect(feed.filter((message) => message.includes("second verification"))).toEqual(["The second verification session stopped early; keeping the verdicts it reached."]);
    // The line counts what was ruled on: the first band, and five of the second.
    expect(feed.filter((message) => message.startsWith("Verified"))).toEqual(["Verified 35: 2 confirmed."]);
  });

  it("a first session that fails still fails the scan, with the second under way: nothing charged, the sandbox deleted", async () => {
    host.extraFiles = 43;
    host.outcome.refute = "fail";
    const scanId = await newScan();
    const credits = autumn.get(orgId).credits;
    const error = await runSlice(scanId);
    expect(error?.message).toBe("The verification in the sandbox stopped before it finished. Nothing was charged.");
    // The second was running beside it, and was never collected: the sandbox goes with both.
    expect(host.log).toEqual(["start:verify", "start:verify2"]);
    expect(await scanById(database, scanId)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
    expect(autumn.get(orgId).credits).toBe(credits);
    expect((await sandboxOf(scanId)).destroyed).toBe(true);
    expect(await verifyStages(scanId)).toEqual([
      ["verify", 0, true, "failed"],
      ["verify2", 0, true, "failed"],
    ]);
    expect((await stagesOf(scanId)).every((s) => s.ended)).toBe(true);
    expect((await scanById(database, scanId))!.stats).not.toHaveProperty("findingIds");

    // One that ends with no verdicts, started again, and ending with none again: the scan stops there, whatever the second wrote.
    const empty = (await hunted(43)).scanId;
    expect(await startSliceSession(empty, "verify")).toEqual({ started: true });
    expect(await startSliceSession(empty, "verify2")).toEqual({ started: true });
    expect(await collectSliceSession(empty, "verify")).toEqual({ real: 0, restart: true });
    // The collect step run again before the restart has started: the same answer, and still one restart.
    expect(await collectSliceSession(empty, "verify")).toEqual({ real: 0, restart: true });
    expect(sliceState((await scanById(database, empty))!)).toMatchObject({ restarts: 1, sessions: { verify2: { slot: "band2" } } });
    expect(sliceState((await scanById(database, empty))!).sessions).not.toHaveProperty("verify");
    expect(await startSliceSession(empty, "verify")).toEqual({ started: true });
    await expect(collectSliceSession(empty, "verify")).rejects.toThrow("The verification in the sandbox ended without a result. Nothing was charged.");
    expect(sliceState((await scanById(database, empty))!).restarts).toBe(1);
    await cleanUpSlice(empty);
    await failScan(empty, "The verification in the sandbox ended without a result. Nothing was charged.");
    expect(await scanById(database, empty)).toMatchObject({ status: "failed", billing: "released", credits: 0 });

    // One that cannot start: the second is never started.
    host.reset();
    host.extraFiles = 43;
    host.outcome.refute = "throw";
    const unstarted = await newScan();
    expect((await runSlice(unstarted))?.message).toBe("Relay exited before it was ready");
    expect(host.started).toEqual([]);
    expect(await scanById(database, unstarted)).toMatchObject({ status: "failed", billing: "released", credits: 0 });
  });

  it("a first session that ends by itself with no verdicts is started again, once: the scan finishes on the second run and is billed for that run, not for the one that ruled on nothing", async () => {
    await withSettings(USAGE_ENV, async () => {
      autumn.get(orgId).credits = 10_000;
      await resetCarry();
      const { scanId, result, findings } = await hunted(43, { state: "running", engine: "slice", pricing: "usage" });
      // One real candidate in each band.
      host.realSinks = [findings[2]!.sink, findings[40]!.sink];
      host.emptyFirst = 1;
      await verifyThenVariants(scanId, result);
      // The second band ran beside both, and is collected after the restarted first.
      expect(host.log.filter((line) => line.includes("verify"))).toEqual(["start:verify", "start:verify2", "collect:verify", "start:verify", "collect:verify", "collect:verify2"]);
      expect(tokensOf(scanId).map((claims) => [claims!.stage, claims!.attempt])).toEqual([
        ["verify", 0],
        ["verify2", 0],
        ["verify", 1],
      ]);
      const state = sliceState((await scanById(database, scanId))!);
      expect(state.restarts).toBe(1);
      expect(state.sessions!.verify).toMatchObject({ attempt: 1, collected: true, verdicts: 30, real: 1 });
      expect(state.sessions!.verify2).toMatchObject({ attempt: 0, collected: true, verdicts: 15, real: 1 });
      expect((await verifyStages(scanId)).sort()).toEqual([
        ["verify", 0, true, "ok"],
        ["verify", 1, true, "ok"],
        ["verify2", 0, true, "ok"],
      ]);
      const feed = await feedOf(scanId);
      expect(feed.filter((message) => message.startsWith("Verif") || message.startsWith("The verification"))).toEqual([
        "Verifying 45 candidates against the code in the sandbox…",
        "The verification ended without a result; running it again.",
        "Verifying 45 candidates against the code in the sandbox…",
        "Verified 45: 2 confirmed.",
      ]);
      expect(await writeUpSlice(scanId)).toEqual({ findings: 2 });
      expect(await findingSinks(scanId)).toEqual([findings[2]!.sink, findings[40]!.sink].sort());

      // Both runs are in the ledger; the bill counts the one that ruled.
      expect(await agentRows(scanId, "verify")).toEqual([
        ["model", "verify", "agent", 0, "ok", "0.0020000000"],
        ["model", "verify", "agent", 1, "ok", "0.0020000000"],
      ]);
      expect(await bill(scanId)).toMatchObject({ state: "billed", status: "open" });
      const stored = (await scanBill(database, scanId))!;
      expect(stored.costMicroUsd).toBe((await ledgerMicroUsd(scanId)) - 2_000);
      expect(stored.lines.filter((line) => line.stage === "verify").map((line) => line.costMicroUsd)).toEqual([2_000]);
      await publishSlice(scanId);
      expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "charged", credits: stored.credits });
      expect(autumn.get(orgId).credits).toBe(10_000 - stored.credits);
      await resetCarry();
    });
  });

  it("a deep scan of a repository the installation can no longer read is refused with a plain reason: one sandbox, no retry, nothing charged, the repository disabled", async () => {
    const NOT_FOUND = "Clone failed: remote: Repository not found.\nfatal: repository 'https://github.com/acme/app.git/' not found";
    const enabledIds = async () => (await database.query.repos.findMany({ where: (r, { and, eq }) => and(eq(r.orgId, orgId), eq(r.enabled, true)) })).map((r) => r.githubRepoId);
    const repoOf = async (scanId: string) => (await scanById(database, scanId))!.repo;

    // GitHub still lists the repository: the failure is a failure like any other, left to the step's retry.
    host.cloneFails = NOT_FOUND;
    const listed = await newScan();
    gh.listed = await enabledIds();
    let sandboxes = sandboxCount();
    expect((await runSlice(listed))?.message).toBe(NOT_FOUND);
    expect(sandboxCount()).toBe(sandboxes + 1);
    expect(await scanById(database, listed)).toMatchObject({ status: "failed", error: NOT_FOUND, billing: "released", credits: 0 });
    expect((await repoOf(listed)).enabled).toBe(true);

    // GitHub no longer lists it: refused, and disabled as its removal would have.
    const gone = await newScan();
    const lost = (await repoOf(gone)).githubRepoId;
    gh.listed = (await enabledIds()).filter((id) => id !== lost);
    const credits = autumn.get(orgId).credits;
    sandboxes = sandboxCount();
    expect((await runSlice(gone))?.message).toBe(REPO_UNREADABLE);
    expect(sandboxCount()).toBe(sandboxes + 1);
    expect(await scanById(database, gone)).toMatchObject({ status: "refused", error: REPO_UNREADABLE, billing: "released", credits: 0 });
    expect(autumn.get(orgId).credits).toBe(credits);
    expect((await repoOf(gone)).enabled).toBe(false);
    expect(await enabledIds()).toEqual(expect.arrayContaining(gh.listed));
    expect((await sandboxOf(gone)).destroyed).toBe(true);
  });

  it("a first session that runs out of time with no verdicts is not started again: the scan fails", async () => {
    const { scanId } = await hunted(0);
    host.emptyFirst = 1;
    expect(await startSliceSession(scanId, "verify")).toEqual({ started: true });
    await expect(collectSliceSession(scanId, "verify", { timedOut: true })).rejects.toThrow("The verification in the sandbox ended without a result. Nothing was charged.");
    expect(sliceState((await scanById(database, scanId))!).restarts).toBeUndefined();
    await cleanUpSlice(scanId);
    await failScan(scanId, "The verification in the sandbox ended without a result. Nothing was charged.");
  });

  it("a pull request review's session that ends with no verdicts is started again too", async () => {
    host.emptyFirst = 1;
    gh.files = [CHANGED, DOCS];
    const scanId = await newScan("pr_review");
    expect(await runSlice(scanId)).toBeUndefined();
    expect(host.log.filter((line) => line.includes("verify"))).toEqual(["start:verify", "collect:verify", "start:verify", "collect:verify"]);
    expect(sliceState((await scanById(database, scanId))!)).toMatchObject({ restarts: 1, sessions: { verify: { attempt: 1, collected: true } } });
    expect(await scanById(database, scanId)).toMatchObject({ status: "completed" });
  });

  it("a candidate only the second session confirmed is written up, with no variants session", async () => {
    const { scanId, result, findings } = await hunted(43);
    host.realSinks = [findings[35]!.sink];
    await verifyThenVariants(scanId, result);
    const state = sliceState((await scanById(database, scanId))!);
    expect(state.sessions!.verify).toMatchObject({ collected: true, verdicts: 30, real: 0 });
    expect(state.sessions!.verify2).toMatchObject({ collected: true, verdicts: 15, real: 1 });
    expect(sessionsOf(scanId).map((s) => [s.kind, s.slot])).toEqual([
      ["refute", undefined],
      ["refute", "band2"],
    ]);
    expect(await writeUpSlice(scanId)).toEqual({ findings: 1 });
    await publishSlice(scanId);
    const scan = (await scanById(database, scanId))!;
    expect(scan).toMatchObject({ status: "completed", billing: "charged", credits: 500 });
    expect(await findingSinks(scanId)).toEqual([findings[35]!.sink]);
    // No variants were looked for, so the finding lists no other place.
    const [finding] = await database.query.findings.findMany({ where: (f, { eq }) => eq(f.repoId, scan.repoId) });
    expect(finding!.alsoReported).toBeNull();
    expect((await feedOf(scanId)).filter((message) => message.startsWith("Verified"))).toEqual(["Verified 45: 1 confirmed."]);
  });

  it("a scan whose verification was recorded by the previous code completes", async () => {
    const { scanId, findings } = await hunted(0);
    expect(await startSliceSession(scanId, "verify")).toEqual({ started: true });
    await sliceSessionStatus(scanId, "verify");
    expect(await sliceSessionStatus(scanId, "verify")).toEqual({ state: "finished" });
    const scan = (await scanById(database, scanId))!;
    const started = sliceState(scan).sessions!.verify!;
    // A session with no slot is recorded as that code recorded it.
    expect(Object.keys(started).sort()).toEqual(["agentProcessId", "attempt", "relayProcessId", "startedAt"]);
    // As that code left a collected verification: every verdict the session wrote in the one file (one of
    // them under an id the hunt never gave), the confirmed findings, and the counts of the one session.
    const verdicts = slice.parseVerdicts(
      JSON.stringify([...findings.map((entry) => ({ id: entry.id, verdict: entry.sink === `${PATH}:3` ? "real" : "false", attacker: "any signed-in user", victim: "other workspaces", reason: "No ownership check." })), { id: "F31", verdict: "real", reason: "Not a candidate." }]),
    );
    const sandbox = await sandboxOf(scanId);
    await sandbox.writePrivateFiles([
      { name: "slice-verify.json", content: JSON.stringify(verdicts) },
      { name: "slice-confirmed.json", content: JSON.stringify(slice.confirmedEntries(findings, verdicts, { checkoutRoot: sandbox.root })) },
    ]);
    await updateScan(database, scanId, { stats: { ...(scan.stats as Record<string, unknown>), slice: { ...sliceState(scan), sessions: { verify: { ...started, collected: true, verdicts: 3, real: 1 } } } } });

    // The rest of the scan on this code.
    expect(await collectSliceSession(scanId, "verify")).toEqual({ real: 1 });
    await sessions(scanId, ["variants"]);
    expect(await writeUpSlice(scanId)).toEqual({ findings: 1 });
    await publishSlice(scanId);
    expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "charged", credits: 500 });
    expect(await findingSinks(scanId)).toEqual([`${PATH}:3`]);
    expect(Object.keys(sliceState((await scanById(database, scanId))!).sessions!)).toEqual(["verify", "variants"]);
    expect(await verifyStages(scanId)).toEqual([["verify", 0, true, "ok"]]);
  });

  it("a workflow run started by the previous code, which knows one verification session, verifies the first band and completes", async () => {
    const { scanId, result, findings } = await hunted(43);
    host.realSinks = [findings[2]!.sink, findings[40]!.sink];
    // That run reads how many were selected and whether variants follow from the hunt step's result, and nothing else.
    await verifyThenVariants(scanId, { selected: result.selected, variants: result.variants });
    expect(sessionsOf(scanId).map((s) => [s.kind, s.slot, s.findings.length])).toEqual([["refute", undefined, 30]]);
    expect(await writeUpSlice(scanId)).toEqual({ findings: 1 });
    await publishSlice(scanId);
    expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "charged", credits: 500 });
    expect(await findingSinks(scanId)).toEqual([findings[2]!.sink]);
    expect(await verifyStages(scanId)).toEqual([["verify", 0, true, "ok"]]);
    expect((await feedOf(scanId)).filter((message) => message.startsWith("Verified"))).toEqual(["Verified 30: 1 confirmed."]);
  });

  it("a pull request review never gets a second session, and its agent only the one relay port", async () => {
    gh.files = [CHANGED, DOCS];
    const scanId = await newScan("pr_review");
    expect(await beginScan(scanId)).toEqual({ state: "running", engine: "slice" });
    const result = await huntSlice(scanId, { passDelayMs: 0 });
    expect(result).toEqual({ selected: 1, variants: false, secondBand: false });
    expect((await sandboxOf(scanId)).setup).toContain(`LOOPBACK_PORTS='${RELAY_PORT}'`);
    // Asked for one all the same, it starts nothing.
    expect(await startSliceSession(scanId, "verify2")).toEqual({ started: false });
    expect(await sessions(scanId, ["verify", "verify2"])).toBe(1);
    expect(host.started.map((s) => [s.kind, s.slot])).toEqual([["refute", undefined]]);
    expect(tokensOf(scanId).map((claims) => claims!.stage)).toEqual(["verify"]);
    expect(await writeUpSlice(scanId)).toEqual({ findings: 1 });
    await publishSlice(scanId);
    expect(await scanById(database, scanId)).toMatchObject({ status: "completed", billing: "charged", credits: prReviewCredits(3) });
    expect(Object.keys(sliceState((await scanById(database, scanId))!).sessions!)).toEqual(["verify"]);
    expect(await verifyStages(scanId)).toEqual([["verify", 0, true, "ok"]]);
    expect((await usage(scanId)).filter((r) => r.step === "verify2")).toEqual([]);
  });
});
