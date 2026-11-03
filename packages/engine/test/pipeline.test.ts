import { describe, expect, test } from "bun:test";
import { IndexerError, type IndexerClient } from "../src/indexer";
import { LlmError, LlmQuotaError, type ChatRequest, type ChatResult, type LlmClient, type ToolCall } from "../src/llm";
import { runScan, type ScanEvent, type ThreatModel } from "../src/scan";
import type { Classifier } from "../src/llm/classifier";

const FILE = ["export function login(req) {", "  const email = req.body.email;", "  return db.query(\"SELECT * FROM users WHERE email = '\" + email + \"'\");", "}"];

/** An indexer over one file, with one route and one sink. */
function fakeIndexer(overrides: Partial<Record<string, (args: Record<string, unknown>) => unknown>> = {}): IndexerClient {
  const tools: Record<string, (args: Record<string, unknown>) => unknown> = {
    overview: () => ({
      files: 1, sourceFiles: 1, testFiles: 0, loc: 4, languages: [{ language: "typescript", files: 1, loc: 4 }],
      topDirectories: [{ path: "src", files: 1, loc: 4 }], routes: 1, routeFrameworks: { express: 1 }, sinks: {},
      secrets: 0, injectionMarkers: 0, dependencies: { total: 0, direct: 0 }, manifests: [], indexMs: 1,
    }),
    routes: () => ({ routes: [{ method: "POST", path: "/login", at: "src/login.ts:1", chain: ["login"], handlers: ["login @ src/login.ts:1"], framework: "express" }], total: 1 }),
    leads: () => ({ secrets: [{ rule: "jwt", at: "src/login.ts:2", redacted: "eyJh… (40 chars)" }], injectionMarkers: [], sinks: [] }),
    deps: () => ({ dependencies: [] }),
    locate: (args) => ({
      locations: (args.locations as Array<{ file: string; line: number }>).map(({ file, line }) =>
        file === "src/login.ts" && line <= FILE.length ? { file, line, exists: true, text: FILE[line - 1], symbol: "login", totalLines: FILE.length } : { file, line, exists: false },
      ),
    }),
    read_file: (args) => {
      const start = Math.max(1, Number(args.startLine ?? 1));
      const end = Math.min(FILE.length, Number(args.endLine ?? FILE.length));
      return { path: args.path, startLine: start, endLine: end, totalLines: FILE.length, truncated: false, content: `${FILE.slice(start - 1, end).join("\n")}\n` };
    },
    ...overrides,
  };
  return {
    async ready() {},
    async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
      const handler = tools[tool];
      if (!handler) throw new IndexerError(`unknown tool ${tool}`, "bad_request");
      return handler(args) as T;
    },
  };
}

const threatModel: ThreatModel = {
  summary: "A login service.",
  stack: ["typescript"],
  entryPoints: [],
  authModel: "None.",
  trustBoundaries: [],
  sensitiveAssets: [],
  dangerousSinks: [],
  frameworkProtections: [],
  abuseSurfaces: [],
  subsystems: [{ name: "auth", paths: ["src"], description: "Login.", risk: "high" }],
};

const authModel = {
  summary: "Login service; identity via session cookie.",
  enforcementPoints: [{ mechanism: "requireAuth middleware", where: "src/login.ts:1", protects: "authenticated routes" }],
  ownershipPattern: "none found",
  gaps: [],
};

const candidate = {
  title: "SQL injection in login via email",
  category: "sql_injection",
  severity: "critical",
  entryPoint: { file: "src/login.ts", line: 1, description: "POST /login, body.email" },
  path: [
    { file: "src/login.ts", line: 2, note: "email read from the body" },
    { file: "src/login.ts", line: 3, note: "concatenated into the query" },
  ],
  preconditions: { attacker: "unauthenticated", trigger: "POSTs a crafted email to the login form", details: "none" },
  proofOfConcept: "POST /login email=' OR '1'='1",
  impact: "Logs in as any user.",
};

const writeUp = {
  title: "SQL injection in login",
  severity: "critical",
  cwe: "CWE-89",
  impact: "Anyone can read the users table.",
  mitigations: "",
  preconditions: "Unauthenticated.",
  proofOfConcept: "POST /login email=' OR '1'='1",
  fixGuidance: "Bind the email as a query parameter.",
  guarantees: ["Input never changes the query"],
  mustNotBreak: ["Valid logins"],
  regressionTest: "Send the payload and assert 401.",
};

type Script = (request: ChatRequest) => ChatResult | Promise<ChatResult>;

function reply(content: string, toolCalls: ToolCall[] = []): ChatResult {
  return {
    content,
    reasoning: "",
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
    usage: { inputTokens: 100, cachedTokens: 80, outputTokens: 10, reasoningTokens: 0 },
    message: { role: "assistant", content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    retries: 0,
  };
}

function toolCall(name: string, args: unknown): ToolCall {
  return { id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** A model that behaves sensibly for every role. `hunter` overrides what hunters do. */
function fakeClient(hunter?: Script, overrides: { reconObject?: Script; verdict?: Record<string, unknown> } = {}): LlmClient {
  const answered = (request: ChatRequest) => request.messages.some((m) => m.role === "tool");
  return {
    config: { baseUrl: "http://fake", apiKey: "k", model: "m" },
    async chat(request) {
      if (request.responseFormat) {
        if (request.role === "recon") return overrides.reconObject ? overrides.reconObject(request) : reply(JSON.stringify(threatModel));
        if (request.role === "skeptic") return reply(JSON.stringify(authModel)); // auth-model investigation
        return reply(JSON.stringify(writeUp));
      }
      const hasVerdictTool = JSON.stringify(request.tools ?? []).includes("submit_verdict");
      switch (request.role) {
        case "recon":
          return reply("Notes: one login route.");
        case "hunt":
          if (hunter) return hunter(request);
          return answered(request) ? reply("Covered login.") : reply("", [toolCall("report_finding", candidate)]);
        case "skeptic":
          // The review skeptic has the verdict tool; the auth-model investigation does not.
          return hasVerdictTool
            ? reply("", [toolCall("submit_verdict", overrides.verdict ?? { verdict: "confirmed", confidence: "high", disproof: [], severity: "critical", reasoning: "Read every hop; the email is concatenated." })])
            : reply("Auth notes: requireAuth guards routes at src/login.ts:1.");
        default:
          throw new Error(`unexpected role ${request.role}`);
      }
    },
  };
}

function scan(client: LlmClient, indexer = fakeIndexer(), events: ScanEvent[] = []) {
  return runScan({ client, indexer, limits: { maxHunters: 3 }, onEvent: (event) => events.push(event) });
}

describe("runScan", () => {
  test("turns a reported candidate into a verified, written-up finding", async () => {
    const events: ScanEvent[] = [];
    const report = await scan(fakeClient(), fakeIndexer(), events);

    expect(report.findings).toHaveLength(1);
    const [finding] = report.findings;
    expect(finding).toMatchObject({ title: "SQL injection in login", severity: "critical", confidence: "high", cwe: "CWE-89", category: "sql_injection" });
    expect(finding!.attackPath.at(-1)!.excerpt).toContain("3| ");
    expect(finding!.fixPrompt).toContain("src/login.ts:3");
    // Two hunters reported the same bug; the gate merged them.
    expect(report.stats.candidates).toBe(1);
    expect(report.stats.duplicates).toBeGreaterThanOrEqual(1);
    expect(report.leads.map((lead) => lead.kind)).toEqual(["secret"]);
    expect(events.some((event) => event.type === "finding")).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  test("a bug nobody can set off on purpose is dropped without citations, as no vulnerability", async () => {
    const events: ScanEvent[] = [];
    const verdict = { verdict: "not_a_vulnerability", confidence: "high", disproof: [], severity: "medium", reasoning: "Only a GPU driver reset sets it off; no attacker controls that." };
    const report = await scan(fakeClient(undefined, { verdict }), fakeIndexer(), events);
    expect(report.findings).toEqual([]);
    expect(report.dismissed.map((d) => [d.title, d.disproof])).toEqual([[candidate.title, []]]);
    expect(events.some((e) => e.type === "progress" && e.message.includes("(no attacker can use it)"))).toBe(true);
  });

  test("rejects citations that do not exist and tells the hunter", async () => {
    const replies: string[] = [];
    const hunter: Script = (request) => {
      const last = request.messages.at(-1)!;
      if (last.role === "tool") {
        replies.push(last.content);
        return reply("done");
      }
      return reply("", [toolCall("report_finding", { ...candidate, path: [{ file: "src/nope.ts", line: 9, note: "made up" }] })]);
    };
    const report = await scan(fakeClient(hunter));
    expect(report.findings).toEqual([]);
    expect(report.stats.rejectedByGate).toBeGreaterThan(0);
    expect(replies[0]).toContain("src/nope.ts does not exist");
  });

  test("a failing hunter costs only its own work", async () => {
    let calls = 0;
    const hunter: Script = (request) => {
      // The first hunter to ask fails outright; the others work normally.
      if (calls++ === 0) throw new LlmError("upstream exploded", { retryable: false, status: 500 });
      return request.messages.some((m) => m.role === "tool") ? reply("done") : reply("", [toolCall("report_finding", candidate)]);
    };
    const report = await scan(fakeClient(hunter));
    expect(report.findings).toHaveLength(1);
    expect(report.stats.hunters.filter((h) => h.error)).toHaveLength(1);
    expect(report.warnings.some((w) => w.includes("stopped early") && w.includes("upstream exploded"))).toBe(true);
  });

  test("quota errors stop the whole scan", async () => {
    const hunter: Script = () => {
      throw new LlmQuotaError("Model request failed with 402: out of credits", { retryable: false, status: 402 });
    };
    await expect(scan(fakeClient(hunter))).rejects.toBeInstanceOf(LlmQuotaError);
  });

  test("a dead indexer stops the scan instead of feeding agents errors", async () => {
    const indexer = fakeIndexer({
      locate: () => {
        throw new IndexerError("Indexer unreachable: connection refused", "unavailable");
      },
    });
    await expect(scan(fakeClient(), indexer)).rejects.toThrow("Indexer unreachable");
  });

  test("falls back to a directory-based threat model when recon cannot write one", async () => {
    const reconObject: Script = () => {
      throw new LlmError("Model sent nothing for 120000ms", { retryable: true });
    };
    const report = await scan(fakeClient(undefined, { reconObject }));
    expect(report.threatModel.subsystems.map((s) => s.paths)).toEqual([["src"]]);
    expect(report.warnings.some((w) => w.includes("hunting by directory"))).toBe(true);
    expect(report.findings).toHaveLength(1);
  });

  test("cancellation rejects promptly with the caller's reason", async () => {
    const controller = new AbortController();
    const hunter: Script = (request) =>
      new Promise((_, reject) => {
        controller.abort(new Error("Interrupted"));
        request.signal?.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
        if (request.signal?.aborted) reject(request.signal.reason);
      });
    const run = runScan({ client: fakeClient(hunter), indexer: fakeIndexer(), signal: controller.signal });
    await expect(run).rejects.toThrow("Interrupted");
  });
});

describe("PR review", () => {
  const files = (overrides: Partial<import("../src/scan").ChangedFile>[] = [{}]) =>
    overrides.map((o) => ({ path: "src/login.ts", status: "modified" as const, additions: 3, deletions: 1, hunks: [[1, 4]] as Array<[number, number]>, patch: "@@ -1,3 +1,4 @@", ...o }));

  test("reviews the change and keeps findings that touch it", async () => {
    const report = await runScan({ client: fakeClient(), indexer: fakeIndexer(), threatModel, pullRequest: { files: files() } });
    expect(report.findings).toHaveLength(1);
    expect(report.review).toEqual({ files: 1, changedLines: 4, reviewedFiles: ["src/login.ts"], skippedFiles: [] });
    expect(report.stats.hunters.map((h) => h.name)).toContain("change");
  });

  test("rejects findings that do not touch the change", async () => {
    const report = await runScan({ client: fakeClient(), indexer: fakeIndexer(), threatModel, pullRequest: { files: files([{ hunks: [[200, 210]] }]) } });
    expect(report.findings).toEqual([]);
    expect(report.stats.rejectedByGate).toBeGreaterThan(0);
  });

  test("a change with nothing security-relevant makes no model calls", async () => {
    const client: LlmClient = { ...fakeClient(), chat: async () => { throw new Error("no model calls expected"); } };
    const report = await runScan({
      client,
      indexer: fakeIndexer(),
      pullRequest: { files: files([{ path: "README.md" }, { path: "src/login.test.ts" }, { path: "package-lock.json" }]) },
    });
    expect(report.findings).toEqual([]);
    expect(report.review?.files).toBe(0);
    expect(report.usage.total.requests).toBe(0);
  });
});

describe("runScan with an entry-point classifier", () => {
  const definitions = () => ({
    definitions: [
      { name: "login", kind: "function", file: "src/login.ts", line: 1, endLine: 4 },
      { name: "Admin.post", kind: "method", file: "src/admin.ts", line: 1, endLine: 4 },
    ],
    total: 2,
  });

  test("a misconfigured classifier warns loudly and never fails the scan", async () => {
    const events: ScanEvent[] = [];
    const broken: Classifier = { model: "x", ask: async () => Promise.reject(new Error("classifier 401: bad key")) };
    const report = await runScan({ client: fakeClient(), classifier: broken, indexer: fakeIndexer({ definitions }), limits: { maxHunters: 3 }, onEvent: (e) => events.push(e) });
    expect(report.findings).toHaveLength(1);
    expect(events.some((e) => e.type === "warning" && e.message.includes("LLM_CLASSIFIER_"))).toBe(true);
  });

  test("a working classifier recovers missed handlers and reports it", async () => {
    const events: ScanEvent[] = [];
    const works: Classifier = {
      model: "x",
      ask: async (state) => ({
        answers: {
          is_http_handler: { type: "noul", noul: state.includes("Admin.post") || state.includes("# login") ? 0.97 : 0.02 },
          enforces_authz: { type: "noul", noul: 0.9 },
          auth_level: { type: "choice", choice: "authenticated", confidence: 0.9, probabilities: {} },
        },
        inputTokens: 10,
      }),
    };
    const report = await runScan({ client: fakeClient(), classifier: works, indexer: fakeIndexer({ definitions }), limits: { maxHunters: 3 }, onEvent: (e) => events.push(e) });
    expect(report.findings).toHaveLength(1);
    expect(events.some((e) => e.type === "progress" && /recovered 1 entry point /.test(e.message))).toBe(true);
    expect(events.some((e) => e.type === "warning")).toBe(false);
  });
});

describe("runScan learns from the team's verdicts on this repo", () => {
  const history = {
    findings: [
      { title: "IDOR on invoice download", category: "broken_access_control", at: "src/invoices.ts:40", outcome: "fixed" as const },
      { title: "Open redirect after login", category: "open_redirect", at: "src/login.ts:2", outcome: "false_positive" as const },
    ],
  };

  test("fixed issues seed variant hunting; false-positive verdicts ground the skeptic", async () => {
    const systems: Record<string, string[]> = { hunt: [], skeptic: [] };
    const base = fakeClient();
    const client: LlmClient = {
      ...base,
      chat: (request) => {
        const system = request.messages.find((m) => m.role === "system")?.content;
        const isReview = JSON.stringify(request.tools ?? []).includes("submit_verdict");
        if (typeof system === "string" && (request.role === "hunt" || (request.role === "skeptic" && isReview))) systems[request.role]!.push(system);
        return base.chat(request);
      },
    };
    const report = await runScan({ client, indexer: fakeIndexer(), history, limits: { maxHunters: 3 } });
    expect(report.findings).toHaveLength(1);
    const hunt = systems.hunt!.join("\n");
    const skeptic = systems.skeptic!.join("\n");
    expect(hunt).toContain("IDOR on invoice download");
    expect(hunt).toContain("variants");
    expect(hunt).not.toContain("Open redirect after login"); // false positives don't steer hunters
    expect(skeptic).toContain("Open redirect after login");
    expect(skeptic).not.toContain("IDOR on invoice download");
  });

  test("with no history the prompts carry no history section", async () => {
    const systems: string[] = [];
    const base = fakeClient();
    const client: LlmClient = { ...base, chat: (request) => (systems.push(String(request.messages[0]?.content ?? "")), base.chat(request)) };
    await runScan({ client, indexer: fakeIndexer(), limits: { maxHunters: 3 } });
    expect(systems.join("\n")).not.toContain("this team");
  });

  test("findings are attributed to the signal that raised them", async () => {
    const report = await runScan({ client: fakeClient(), indexer: fakeIndexer(), limits: { maxHunters: 3 } });
    expect(report.findings[0]!.sources).toEqual(["hunter"]);
  });
});
