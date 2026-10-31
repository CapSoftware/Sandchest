import { describe, expect, test } from "bun:test";
import type { IndexerClient } from "../src/indexer";
import { CandidateRegistry, checkEvidence, fingerprint, type GatedCandidate, type Located } from "../src/scan/gate";
import { fixPrompt } from "../src/scan/fix-prompt";
import { planAssignments, planCoverage } from "../src/scan/hunt";
import { Limiter, UsageMeter } from "../src/scan/metrics";
import { runAgent } from "../src/scan/agent";
import { agentTool } from "../src/scan/tools";
import { defineTool, type LlmClient } from "../src/llm";
import { z } from "zod";
import { compareVersions, fixedVersionFor } from "../src/scan/osv";
import { renderThreatModel } from "../src/scan/prompts";
import type { Candidate, Finding, ThreatModel } from "../src/scan/schema";
import { createWrap, numberLines } from "../src/scan/tools";

const candidate: Candidate = {
  title: "SQL injection in login via email",
  category: "sql_injection",
  severity: "critical",
  entryPoint: { file: "routes/login.ts", line: 10, description: "POST /login, body.email" },
  path: [
    { file: "routes/login.ts", line: 12, note: "email read from body" },
    { file: "routes/login.ts", line: 14, note: "concatenated into the query" },
  ],
  preconditions: { attacker: "unauthenticated", details: "none" },
  proofOfConcept: "POST /login email=' OR 1=1--",
  impact: "Logs in as any user.",
};

/** An indexer whose files are given inline. */
function fakeIndexer(files: Record<string, string[]>): IndexerClient {
  return {
    async ready() {},
    async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
      if (tool !== "locate") throw new Error(`unexpected tool ${tool}`);
      const locations = (args.locations as Array<{ file: string; line: number }>).map(({ file, line }) => {
        const lines = files[file];
        if (!lines) return { file, line, exists: false };
        const text = lines[line - 1];
        return text === undefined
          ? { file, line, exists: false, totalLines: lines.length }
          : { file, line, exists: true, text, symbol: "login", totalLines: lines.length };
      });
      return { locations } as T;
    },
  };
}

const loginFile = Array.from({ length: 20 }, (_, i) => (i === 13 ? "db.query(\"SELECT * FROM users WHERE email = '\" + email + \"'\")" : `line ${i + 1}`));

describe("evidence gate", () => {
  test("accepts citations that exist", async () => {
    const result = await checkEvidence(fakeIndexer({ "routes/login.ts": loginFile }), candidate);
    expect(result.ok).toBe(true);
  });

  test("rejects missing files and lines past the end", async () => {
    const bad = { ...candidate, path: [{ file: "nope.ts", line: 1, note: "x" }, { file: "routes/login.ts", line: 99, note: "sink" }] };
    const result = await checkEvidence(fakeIndexer({ "routes/login.ts": loginFile }), bad);
    expect(result).toEqual({
      ok: false,
      problems: ["nope.ts does not exist in the repository.", "routes/login.ts:99 is past the end of the file (20 lines)."],
    });
  });

  test("rejects a blank sink line", async () => {
    const blank = [...loginFile];
    blank[13] = "   ";
    const result = await checkEvidence(fakeIndexer({ "routes/login.ts": blank }), candidate);
    expect(result.ok).toBe(false);
  });
});

describe("fingerprint", () => {
  const sink: Located = { file: "routes/login.ts", line: 14, text: "db.query(sql)", symbol: "login" };

  test("ignores line numbers and whitespace", () => {
    expect(fingerprint("sql_injection", { ...sink, line: 40, text: "  db.query( sql)".replace("( ", "(") })).toBe(fingerprint("sql_injection", sink));
  });

  test("changes with the class, file, function or code", () => {
    const base = fingerprint("sql_injection", sink);
    expect(fingerprint("xss", sink)).not.toBe(base);
    expect(fingerprint("sql_injection", { ...sink, file: "routes/other.ts" })).not.toBe(base);
    expect(fingerprint("sql_injection", { ...sink, symbol: "search" })).not.toBe(base);
    expect(fingerprint("sql_injection", { ...sink, text: "db.query(other)" })).not.toBe(base);
  });
});

describe("candidate registry", () => {
  const at = (file: string, line: number, symbol = "fn"): Located => ({ file, line, text: `code ${line}`, symbol });
  const gated = (entry: Located, path: Located[], category: Candidate["category"] = "broken_access_control"): GatedCandidate => ({
    id: "C1",
    candidate: { ...candidate, category },
    entry,
    path,
    fingerprint: fingerprint(category, path.at(-1)!),
    hunter: "h",
  });

  test("matches the same bug cited through a different sink", () => {
    const registry = new CandidateRegistry();
    registry.add(gated(at("routes/index.js", 63), [at("routes/a.js", 16), at("views/a.html", 35)]));
    const path = [at("routes/index.js", 63), at("dao/a.js", 86)];
    expect(registry.find("broken_access_control", at("routes/index.js", 63), path, "x")).toBeDefined();
  });

  test("matches mostly shared paths", () => {
    const registry = new CandidateRegistry();
    registry.add(gated(at("routes/index.js", 67), [at("memos.js", 13), at("memos.html", 31), at("server.js", 127)], "xss"));
    const path = [at("memos.js", 13), at("memos.html", 31), at("server.js", 13)];
    expect(registry.find("xss", at("memos.js", 13), path, "x")).toBeDefined();
  });

  test("treats access-control classes as one", () => {
    const registry = new CandidateRegistry();
    registry.add(gated(at("routes/me.ts", 11), [at("lib/users.ts", 14)], "mass_assignment"));
    expect(registry.find("privilege_escalation", at("routes/me.ts", 11), [at("lib/auth.ts", 23)], "x")).toBeDefined();
  });

  test("merges reports of the same vulnerable dependency", () => {
    const registry = new CandidateRegistry();
    const first = gated(at("a.go", 1), [at("go.mod", 19)], "vulnerable_dependency");
    first.candidate.leads = ["L2"];
    registry.add(first);
    expect(registry.find("vulnerable_dependency", at("b.go", 9), [at("c.go", 4)], "x", ["L2"])).toBeDefined();
    expect(registry.find("vulnerable_dependency", at("b.go", 9), [at("c.go", 4)], "x", ["L3"])).toBeUndefined();
  });

  test("keeps different classes and adjacent routes apart", () => {
    const registry = new CandidateRegistry();
    registry.add(gated(at("server.ts", 630), [at("routes/search.ts", 23)], "sql_injection"));
    expect(registry.find("xss", at("server.ts", 630), [at("routes/search.ts", 23)], "x")).toBeUndefined();
    expect(registry.find("sql_injection", at("server.ts", 631), [at("routes/login.ts", 34)], "x")).toBeUndefined();
  });
});

describe("hunt plan", () => {
  const model: ThreatModel = {
    summary: "",
    stack: [],
    entryPoints: [],
    authModel: "",
    trustBoundaries: [],
    sensitiveAssets: [],
    dangerousSinks: [],
    frameworkProtections: [],
    abuseSurfaces: ["Credits are spent per export"],
    subsystems: [
      { name: "billing", paths: ["src/billing"], description: "", risk: "medium" },
      { name: "auth", paths: ["src/auth/"], description: "", risk: "high" },
      { name: "docs", paths: ["docs"], description: "", risk: "low" },
    ],
  };
  const routes = [
    { method: "POST", path: "/login", at: "src/auth/routes.ts:4", chain: [], handlers: [], framework: "express" },
    { method: "GET", path: "/invoices", at: "src/billing/routes.ts:9", chain: ["auth"], handlers: [], framework: "express" },
  ];

  test("riskiest subsystems first, then access control, abuse and leads", () => {
    const leads = [{ id: "L1", kind: "secret" as const, title: "key", at: "config.ts:1", detail: "" }];
    const plan = planAssignments(model, routes, leads, 8, createWrap("t"));
    expect(plan.map((a) => a.name)).toEqual(["auth", "billing", "access control", "abuse", "leads"]);
    expect(plan[3]!.brief).toContain("Credits are spent per export");
    expect(plan[0]!.brief).toContain("POST /login");
    expect(plan[0]!.brief).not.toContain("/invoices");
  });

  test("respects the hunter budget and wraps repository text", () => {
    const plan = planAssignments(model, routes, [], 3, createWrap("t"));
    expect(plan.map((a) => a.name)).toEqual(["auth", "access control", "abuse"]);
    expect(plan[1]!.brief).toContain("<t>\n- POST /login");
  });
});

describe("fix prompt", () => {
  test("covers the vulnerability, path, guarantees and regression test", () => {
    const finding: Omit<Finding, "fixPrompt"> = {
      fingerprint: "abc",
      title: "SQL injection in login",
      severity: "critical",
      confidence: "high",
      category: "sql_injection",
      cwe: "CWE-89",
      impact: "Anyone can log in as any user.",
      entryPoint: candidate.entryPoint,
      attackPath: [{ file: "routes/login.ts", line: 14, note: "concatenated", excerpt: "14| db.query(`x ${email}`)" }],
      attacker: "unauthenticated",
      preconditions: "Unauthenticated.",
      proofOfConcept: "email=' OR 1=1--",
      fixGuidance: "Use a bound parameter.",
      guarantees: ["User input never changes the query structure"],
      mustNotBreak: ["Login with valid credentials"],
      regressionTest: "Log in with the payload and assert 401.",
      leads: [],
      skeptic: { confidence: "high", reasoning: "" },
    };
    const prompt = fixPrompt(finding);
    expect(prompt).toContain("(CWE-89)");
    expect(prompt).toContain("`routes/login.ts:14`");
    expect(prompt).toContain("```\n14| db.query(`x ${email}`)\n```");
    // A fence inside the content gets a longer fence around it.
    expect(fixPrompt({ ...finding, proofOfConcept: "```js\nx\n```" })).toContain("````\n```js\nx\n```\n````");
    expect(prompt).toContain("- User input never changes the query structure");
    expect(prompt).toContain("Write the regression test first");
  });
});

describe("helpers", () => {
  test("numbers lines with aligned widths", () => {
    expect(numberLines("a\nb\n", 9)).toBe(" 9| a\n10| b");
  });

  test("meters usage and cost", () => {
    const meter = new UsageMeter();
    meter.add("hunt", { inputTokens: 1_000_000, cachedTokens: 800_000, outputTokens: 100_000, reasoningTokens: 50_000 });
    meter.add("skeptic", { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 });
    expect(meter.total().requests).toBe(2);
    expect(meter.cost({ input: 1, cachedInput: 0.1, output: 4 })).toBeCloseTo(0.2 + 0.08 + 0.4);
  });
});

describe("advisories", () => {
  const events = [{ introduced: "0" }, { fixed: "15.5.28" }, { introduced: "16.0.0" }, { fixed: "16.3.8" }];

  test("picks the fix on the installed release line", () => {
    expect(fixedVersionFor(events, "16.3.0")).toBe("16.3.8");
    expect(fixedVersionFor(events, "15.1.0")).toBe("15.5.28");
  });

  test("compares versions numerically", () => {
    expect(compareVersions("16.3.10", "16.3.8")).toBeGreaterThan(0);
    expect(compareVersions("v1.2", "1.2.0")).toBe(0);
  });
});

describe("agent budget", () => {
  /** A model that calls the `ping` tool forever. */
  const looping: LlmClient = {
    config: { baseUrl: "http://fake", apiKey: "k", model: "m" },
    async chat() {
      const call = { id: "c", type: "function" as const, function: { name: "ping", arguments: "{}" } };
      return {
        content: "",
        reasoning: "",
        toolCalls: [call],
        finishReason: "tool_calls",
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, reasoningTokens: 0 },
        message: { role: "assistant" as const, content: null, tool_calls: [call] },
        retries: 0,
      };
    },
  };

  test("a turn budget can grow while the agent runs", async () => {
    let earned = 0;
    const ping = agentTool(defineTool({ name: "ping", description: "", args: z.object({}) }), async () => {
      earned++;
      return "pong";
    });
    const result = await runAgent({
      client: looping,
      role: "hunt",
      messages: [{ role: "user", content: "go" }],
      tools: [ping],
      limiter: new Limiter(1),
      meter: new UsageMeter(),
      // Two turns, plus one for every two pings, capped at six.
      maxTurns: () => Math.min(6, 2 + Math.floor(earned / 2)),
    });
    expect(result.turns).toBe(3);
  });
});

describe("coverage pass", () => {
  const sink = (id: string, title: string, at: string) => ({ id, kind: "sink" as const, title, at, detail: "" });
  const leads = [
    sink("L1", "sql sink with built input", "routes/search.ts:23"),
    sink("L2", "sql sink with built input", "routes/login.ts:34"),
    sink("L3", "redirect sink with built input", "routes/redirect.ts:9"),
    sink("L4", "command sink with built input (no route reaches it)", "scripts/build.ts:3"),
    sink("L5", "path sink with variable input", "routes/files.ts:12"),
  ];
  const read = new Set(["routes/search.ts", "routes/login.ts", "routes/redirect.ts"]);

  test("rules on uncited injection sinks even in files someone read", () => {
    const [plan] = planCoverage([], leads, read, [{ file: "routes/login.ts", line: 35 }], createWrap("t"));
    expect(plan!.brief).toContain("routes/search.ts:23");
    expect(plan!.brief).toContain("routes/files.ts:12");
    expect(plan!.brief).not.toContain("routes/login.ts:34");
    expect(plan!.brief).not.toContain("routes/redirect.ts:9");
    expect(plan!.brief).not.toContain("scripts/build.ts");
  });

  test("plans nothing when everything is covered", () => {
    const cited = [{ file: "routes/search.ts", line: 23 }, { file: "routes/login.ts", line: 34 }, { file: "routes/files.ts", line: 12 }];
    expect(planCoverage([], leads, read, cited, createWrap("t"))).toEqual([]);
  });
});

describe("threat model rendering", () => {
  test("tolerates models stored before newer fields existed", () => {
    const old = { summary: "An app.", stack: [], entryPoints: [], authModel: "", trustBoundaries: [], sensitiveAssets: [], dangerousSinks: [], frameworkProtections: [], subsystems: [] };
    expect(renderThreatModel(old as unknown as ThreatModel)).toContain("## Worth abusing\n- (none identified)");
  });
});
