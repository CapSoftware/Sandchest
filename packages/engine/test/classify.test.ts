import { describe, expect, test } from "bun:test";
import type { IndexerClient } from "../src/indexer";
import type { Classifier, ClassifierResult } from "../src/llm/classifier";
import { classifyEntryPoints, entryPointCandidates } from "../src/scan/classify";
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

  test("classifies handler-named files anywhere first, one per file in turn, within the cap", async () => {
    // Routes live in the URL table; the views are elsewhere, and a long helper file would fill a small cap alone.
    const routes: RouteInfo[] = [{ method: "ANY", path: "/members/", at: "app/urls/project.py:5", chain: ["as_view"], handlers: [], framework: "django" }];
    const all = [
      ...Array.from({ length: 5 }, (_, i) => def(`helper${i}`, "app/urls/helpers.py", "function", i + 1)),
      def("MemberView.patch", "app/views/member.py", "method", 40),
      def("MemberView.get", "app/views/member.py", "method", 20),
      def("IssueView.put", "app/views/issue.py", "method", 30),
    ];
    const seen: string[] = [];
    const classifier = fakeClassifier({ "MemberView.patch": { handler: 0.95 } });
    const indexer = fakeIndexer([], routes, {});
    const call = indexer.call.bind(indexer);
    indexer.call = async <T,>(tool: string, args: Record<string, unknown> = {}) =>
      tool === "definitions" ? ({ definitions: args.path ? all.filter((d) => d.file.startsWith(String(args.path))) : all, total: all.length } as T) : call<T>(tool, args);
    const recovery = await classifyEntryPoints(indexer, { ...classifier, ask: (state, q, s) => (seen.push(/^# (\S+)/.exec(state)![1]!), classifier.ask(state, q, s)) }, routes, { maxCandidates: 4, concurrency: 1 });
    expect(seen).toEqual(["IssueView.put", "MemberView.get", "MemberView.patch", "helper0"]);
    expect(recovery.recovered.map((r) => r.at)).toEqual(["app/views/member.py:40"]);
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

  test("reads every definition of a repository too large for one call, a directory at a time", async () => {
    // The indexer returns at most 20,000 per call; the handlers sit alphabetically last.
    const big = Array.from({ length: 20_000 }, (_, i) => def(`util${i}`, `aaa/lib${i % 50}.py`, "function", i + 1));
    const controller = def("TeamResource.addMember", "zzz/resources/team.py");
    const all = [...big, controller];
    const indexer: IndexerClient = {
      async ready() {},
      async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
        if (tool === "routes") return { routes: [], total: 0 } as T;
        if (tool === "list_dir") {
          const dir = String(args.path ?? "");
          const prefix = dir ? `${dir}/` : "";
          const names = new Map<string, "dir" | "file">();
          for (const d of all.filter((d) => d.file.startsWith(prefix))) {
            const rest = d.file.slice(prefix.length);
            names.set(rest.split("/")[0]!, rest.includes("/") ? "dir" : "file");
          }
          return { path: dir, entries: [...names].map(([name, type]) => ({ name, type })) } as T;
        }
        if (tool === "definitions") {
          const matching = all.filter((d) => !args.path || d.file.startsWith(String(args.path)));
          return { definitions: matching.slice(0, Math.min(Number(args.limit ?? 2000), 20_000)), total: matching.length } as T;
        }
        throw new Error(`unexpected tool ${tool}`);
      },
    };
    const candidates = await entryPointCandidates(indexer, [], 10);
    expect(candidates![0]).toEqual(controller);
  });

  test("skips UI components but keeps server code written in JSX", async () => {
    const all = [def("Button.render", "apps/web/components/views/button.tsx"), def("rolesRouter.update", "packages/rpc/server/routers/roles/_router.tsx"), def("Stimulus.connect", "frontend/src/controllers/members.ts")];
    const indexer = fakeIndexer([], [], { definitions: { definitions: all, total: all.length } });
    const candidates = await entryPointCandidates(indexer, [], 10);
    expect(candidates!.map((d) => d.name)).toEqual(["rolesRouter.update"]);
  });
});
