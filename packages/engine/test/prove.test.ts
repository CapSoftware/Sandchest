import { describe, expect, test } from "bun:test";
import type { IndexerClient } from "../src/indexer/client";
import { proveFinding } from "../src/scan";
import { buildEntryIndex } from "../src/scan/prove";
import type { Finding } from "../src/scan";

/** A fake indexer scripted per tool. Unlisted tools return empty. */
function indexerOf(handlers: Record<string, (args: Record<string, unknown>) => unknown>): IndexerClient {
  return {
    call: async <T>(tool: string, args: Record<string, unknown> = {}) => (handlers[tool] ? handlers[tool](args) : {}) as T,
    ready: async () => {},
  };
}

function findingWith(path: Array<{ file: string; line: number }>): Finding {
  return {
    fingerprint: "fp",
    title: "Cross-tenant read",
    severity: "high",
    confidence: "medium",
    category: "broken_access_control",
    cwe: null,
    impact: "reads another tenant's data", mitigations: "",
    entryPoint: { file: "a.ts", line: 10, description: "GET /api/doc/:id" },
    attackPath: path.map((p) => ({ ...p, note: "hop", excerpt: "" })),
    attacker: "any_user",
    preconditions: "any logged-in user",
    proofOfConcept: "GET /api/doc/1 as another user",
    fixGuidance: "scope by owner",
    guarantees: ["owner check"],
    mustNotBreak: [],
    regressionTest: "t",
    fixPrompt: "p",
    leads: [],
    skeptic: { confidence: "medium", reasoning: "r" },
  };
}

const existing = (symbols: Array<string | null>) => (args: Record<string, unknown>) => ({
  locations: (args.locations as Array<{ file: string; line: number }>).map((l, i) => ({ ...l, exists: true, symbol: symbols[i] ?? null })),
});

describe("proveFinding", () => {
  test("confirms a cross-function path when the index traces entry → sink", async () => {
    const indexer = indexerOf({
      locate: existing(["handleGetDoc", "queryDoc"]),
      trace: (args) => (args.from === "handleGetDoc" && args.to === "queryDoc" ? { paths: [{ hops: [{ symbol: "handleGetDoc", definedAt: "a.ts:1" }, { symbol: "queryDoc", definedAt: "b.ts:9" }] }] } : { paths: [] }),
    });
    const v = await proveFinding(indexer, findingWith([{ file: "a.ts", line: 10 }, { file: "b.ts", line: 20 }]));
    expect(v.status).toBe("path_confirmed");
    expect(v.method).toBe("code-path");
  });

  test("confirms via the route anchor when a framework handler has no in-graph callers", async () => {
    // Function→function trace fails (handler invoked by the framework), but route→sink resolves.
    const indexer = indexerOf({
      locate: existing(["GET_handler", "findVideo"]),
      trace: (args) => (args.from === "GET /api/doc/:id" && args.to === "findVideo" ? { paths: [{ hops: [{ symbol: "x", definedAt: "a.ts:1" }] }] } : { paths: [] }),
    });
    const v = await proveFinding(indexer, findingWith([{ file: "a.ts", line: 10 }, { file: "b.ts", line: 20 }]));
    expect(v.status).toBe("path_confirmed");
    expect(v.detail).toContain("GET /api/doc/:id");
  });

  test("confirms a classic sink the index marks route-reachable", async () => {
    const indexer = indexerOf({
      locate: existing(["handler", "handler"]), // one function; trace is skipped
      sinks: (args) => (args.path === "db.ts" ? { sinks: [{ at: "db.ts:42", reachable: true, kind: "sql", in: "q", call: "query", input: "built", code: "" }] } : { sinks: [] }),
    });
    const v = await proveFinding(indexer, findingWith([{ file: "db.ts", line: 40 }, { file: "db.ts", line: 42 }]));
    expect(v.status).toBe("path_confirmed");
  });

  test("stays inconclusive when the path is not connected and the sink is not reachable", async () => {
    const indexer = indexerOf({
      locate: existing(["a", "b"]),
      trace: () => ({ paths: [] }),
      sinks: () => ({ sinks: [{ at: "db.ts:42", reachable: false, kind: "sql", in: "q", call: "query", input: "built", code: "" }] }),
    });
    const v = await proveFinding(indexer, findingWith([{ file: "a.ts", line: 1 }, { file: "db.ts", line: 42 }]));
    expect(v.status).toBe("inconclusive");
  });

  test("a sink reachable: false does not confirm", async () => {
    const indexer = indexerOf({
      locate: existing(["h", "h"]),
      sinks: () => ({ sinks: [{ at: "db.ts:42", reachable: false, kind: "sql", in: "q", call: "query", input: "built", code: "" }] }),
    });
    expect((await proveFinding(indexer, findingWith([{ file: "db.ts", line: 40 }, { file: "db.ts", line: 42 }]))).status).toBe("inconclusive");
  });

  test("confirms a missing-control finding by entry-point reachability (no path to trace)", async () => {
    // A rate-limit finding: entry is a real route, the "sink" is where a limit is absent → no trace path.
    const indexer = indexerOf({ locate: existing(["GET", "checkRateLimit"]), trace: () => ({ paths: [] }), sinks: () => ({ sinks: [] }) });
    const routes = [{ method: "GET", path: "/api/tools/loom-download", at: "a.ts:10", handlers: ["GET @ a.ts:10"], chain: [], framework: "nextjs" }];
    const f = findingWith([{ file: "a.ts", line: 10 }, { file: "lib/rate-limit.ts", line: 5 }]);
    f.category = "resource_abuse"; f.attacker = "unauthenticated"; f.entryPoint.description = "GET /api/tools/loom-download?id=x — public";
    const v = await proveFinding(indexer, f, buildEntryIndex(routes as never));
    expect(v.status).toBe("path_confirmed");
    expect(v.method).toBe("entry-reachable");
  });

  test("entry-reachability does NOT confirm injection classes (their dataflow is the question)", async () => {
    const indexer = indexerOf({ locate: existing(["GET", "query"]), trace: () => ({ paths: [] }), sinks: () => ({ sinks: [] }) });
    const routes = [{ method: "GET", path: "/api/x", at: "a.ts:10", handlers: ["GET @ a.ts:10"], chain: [], framework: "nextjs" }];
    const f = findingWith([{ file: "a.ts", line: 10 }, { file: "a.ts", line: 20 }]);
    f.category = "sql_injection"; f.attacker = "unauthenticated"; f.entryPoint.description = "GET /api/x";
    expect((await proveFinding(indexer, f, buildEntryIndex(routes as never))).status).toBe("inconclusive");
  });

  test("entry-reachability does NOT confirm an entry the index does not know (anti-hallucination)", async () => {
    const indexer = indexerOf({ locate: existing(["GET", "x"]), trace: () => ({ paths: [] }), sinks: () => ({ sinks: [] }) });
    const f = findingWith([{ file: "a.ts", line: 10 }, { file: "b.ts", line: 5 }]);
    f.category = "resource_abuse"; f.attacker = "unauthenticated"; f.entryPoint.description = "GET /api/not-a-real-route";
    expect((await proveFinding(indexer, f, buildEntryIndex([]))).status).toBe("inconclusive");
  });

  test("inconclusive (never dropped) when the cited code has moved", async () => {
    const indexer = indexerOf({
      locate: (args) => ({ locations: (args.locations as Array<{ file: string; line: number }>).map((l) => ({ ...l, exists: false })) }),
    });
    const v = await proveFinding(indexer, findingWith([{ file: "a.ts", line: 1 }, { file: "b.ts", line: 2 }]));
    expect(v.status).toBe("inconclusive");
    expect(v.detail).toContain("moved");
  });

  test("a trace failure falls through to the sink check rather than throwing", async () => {
    const indexer = indexerOf({
      locate: existing(["entry", "sink"]),
      trace: () => { throw new Error("trace blew up"); },
      sinks: () => ({ sinks: [{ at: "b.ts:2", reachable: true, kind: "ssrf", in: "f", call: "fetch", input: "variable", code: "" }] }),
    });
    const v = await proveFinding(indexer, findingWith([{ file: "a.ts", line: 1 }, { file: "b.ts", line: 2 }]));
    expect(v.status).toBe("path_confirmed");
  });
});
