import { describe, expect, test } from "bun:test";
import type { IndexerClient } from "../src/indexer";
import type { Classifier, ClassifierResult } from "../src/llm/classifier";
import { classifyEntryPoints } from "../src/scan/classify";
import type { RouteInfo } from "../src/scan/tools";

interface Def {
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine: number;
}

/** An indexer serving a fixed set of roots and detected routes. */
function fakeIndexer(roots: Def[], routes: RouteInfo[] = [], overrides: Partial<Record<string, unknown>> = {}): IndexerClient {
  return {
    async ready() {},
    async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
      if (tool in overrides) return overrides[tool] as T;
      if (tool === "definitions") return { definitions: (args.roots ? roots : roots), total: roots.length } as T;
      if (tool === "routes") return { routes, total: routes.length } as T;
      if (tool === "read_file") return { path: args.path, startLine: 1, endLine: 10, totalLines: 10, truncated: false, content: `code of ${args.path}` } as T;
      throw new Error(`unexpected tool ${tool}`);
    },
  };
}

/** A classifier that answers from a name→scores map parsed out of the state header. */
function fakeClassifier(scores: Record<string, { handler: number; authz?: number; level?: string }>, opts: { fail?: Set<string>; refuse?: Set<string> } = {}): Classifier {
  return {
    model: "test-classifier",
    async ask(state): Promise<ClassifierResult> {
      const name = /^# (\S+) in/.exec(state)?.[1] ?? "";
      if (opts.fail?.has(name)) throw new Error("classifier 500: boom");
      if (opts.refuse?.has(name)) throw new Error("classifier refused: policy");
      const s = scores[name] ?? { handler: 0, authz: 0.5 };
      return {
        answers: {
          is_http_handler: { type: "noul", noul: s.handler },
          enforces_authz: { type: "noul", noul: s.authz ?? 0.5 },
          auth_level: { type: "choice", choice: s.level ?? (s.handler > 0.5 ? "authenticated" : "not_an_endpoint"), confidence: 0.9, probabilities: {} },
        },
        inputTokens: 100,
      };
    },
  };
}

const def = (name: string, file: string, kind = "method", line = 10): Def => ({ name, kind, file, line, endLine: line + 5 });

describe("classifyEntryPoints", () => {
  test("recovers roots the classifier calls handlers, not the utilities", async () => {
    const roots = [def("Resource.get", "api/users.py"), def("Resource.post", "api/users.py"), def("format_row", "api/users.py", "function"), def("serialize", "api/util.py", "function")];
    // one detected route so api/ is the server-side scope
    const routes: RouteInfo[] = [{ method: "GET", path: "/health", at: "api/health.py:3", chain: [], handlers: ["health @ api/health.py:3"], framework: "flask" }];
    const classifier = fakeClassifier({ "Resource.get": { handler: 0.96, authz: 0.2 }, "Resource.post": { handler: 0.95, authz: 0.9 }, format_row: { handler: 0.05 }, serialize: { handler: 0.03 }, health: { handler: 0.98, authz: 0.9 } });

    const recovery = await classifyEntryPoints(fakeIndexer(roots, routes), classifier, routes);
    const names = recovery.recovered.map((r) => r.path).sort();
    expect(names).toEqual(["Resource.get", "Resource.post"]);
    expect(recovery.recovered[0]!.framework).toBe("recovered");
    expect(recovery.recovered.find((r) => r.path === "Resource.get")!.method).toBe("GET");
    // the detected health handler is also scored (for peer-consistency), plus the two recovered
    expect(recovery.handlers.map((h) => h.name).sort()).toEqual(["Resource.get", "Resource.post", "health"]);
    expect(recovery.stats.recovered).toBe(2);
  });

  test("a classifier failure drops only that candidate, never the run", async () => {
    const roots = [def("A.get", "api/a.py"), def("B.get", "api/b.py")];
    const routes: RouteInfo[] = [{ method: "GET", path: "/x", at: "api/x.py:1", chain: [], handlers: ["x @ api/x.py:1"], framework: "flask" }];
    const classifier = fakeClassifier({ "A.get": { handler: 0.95 }, "B.get": { handler: 0.95 }, x: { handler: 0.95 } }, { fail: new Set(["A.get"]) });
    const recovery = await classifyEntryPoints(fakeIndexer(roots, routes), classifier, routes);
    expect(recovery.recovered.map((r) => r.path)).toEqual(["B.get"]);
    expect(recovery.stats.failures).toBe(1);
  });

  test("returns empty cleanly when the indexer has no definitions tool", async () => {
    const indexer: IndexerClient = {
      async ready() {},
      async call<T>(tool: string): Promise<T> {
        if (tool === "definitions") throw new Error("unknown tool definitions");
        return { routes: [], total: 0 } as T;
      },
    };
    const recovery = await classifyEntryPoints(indexer, fakeClassifier({}), []);
    expect(recovery.recovered).toEqual([]);
    expect(recovery.handlers).toEqual([]);
  });

  test("a hung classifier never stalls the scan: the budget returns partial results", async () => {
    const roots = [def("A.get", "api/a.py"), def("B.get", "api/b.py")];
    const routes: RouteInfo[] = [{ method: "GET", path: "/x", at: "api/x.py:1", chain: [], handlers: [], framework: "flask" }];
    const hung: Classifier = { model: "slow", ask: (_s, _q, signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason))) };
    const started = Date.now();
    const recovery = await classifyEntryPoints(fakeIndexer(roots, routes), hung, routes, { budgetMs: 80 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(recovery.recovered).toEqual([]);
  });

  test("respects the candidate cap", async () => {
    const roots = Array.from({ length: 50 }, (_, i) => def(`H${i}.get`, "api/h.py"));
    const routes: RouteInfo[] = [{ method: "GET", path: "/x", at: "api/x.py:1", chain: [], handlers: [], framework: "flask" }];
    const scores = Object.fromEntries(roots.map((r) => [r.name, { handler: 0.99 }]));
    const recovery = await classifyEntryPoints(fakeIndexer(roots, routes), fakeClassifier(scores), routes, { maxCandidates: 10 });
    expect(recovery.stats.candidates).toBe(10);
    expect(recovery.recovered.length).toBe(10);
  });
});
