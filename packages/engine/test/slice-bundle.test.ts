import { describe, expect, test } from "bun:test";
import { BUNDLE_LIMITS, bundleMode, cutSlicePackets, planBundle, sliceBundle, spanLines, wholeBundle, type Bundle, type Entry, type Span } from "../src/scan/slice";

const lines = (n: number, word = "x") => Array.from({ length: n }, () => word).join("\n") + "\n";
const entry = (at: string, start: number, end: number, extra: Partial<Entry> = {}): Entry => {
  const file = at.slice(0, at.lastIndexOf(":"));
  return { id: "E", method: "GET", path: "/", at, handler: { key: at, name: file, file, start, end }, guards: [], helpers: [], ...extra };
};
const packetLines = (b: Bundle, i: number) => {
  const p = b.packets[i]!;
  return p.shared.reduce((n, k) => n + spanLines(b.spans[k]!), 0) + p.entries.reduce((n, e) => n + spanLines(e.handler), 0);
};

describe("bundleMode", () => {
  test("whole files at or under 40000 server lines, or with fewer than 20 slice entries", () => {
    expect(bundleMode(40_000, 500)).toBe("whole");
    expect(bundleMode(40_001, 19)).toBe("whole");
    expect(bundleMode(40_001, 20)).toBe("hybrid");
    expect(bundleMode(1_000_000, 0)).toBe("whole");
  });
});

describe("wholeBundle", () => {
  test("ranks by risk, chunks 400 lines, stops a file at the budget but tries the next", () => {
    const files = [
      { file: "src/quiet.ts", text: lines(900) },
      { file: "src/risky.ts", text: lines(500, "req.session.user") },
      { file: "src/small.ts", text: lines(50, "token") },
    ];
    const b = wholeBundle(files, { budget: 1000 });
    const chunks = b.packets.flatMap((p) => p.entries).map((e) => `${e.handler.file}:${e.handler.start}-${e.handler.end}`);
    // risky (2 words a line), then small (1), then quiet (0), whose second chunk no longer fits.
    expect(chunks.sort()).toEqual(["src/quiet.ts:1-400", "src/risky.ts:1-400", "src/risky.ts:401-500", "src/small.ts:1-50"].sort());
    expect(b.stats).toEqual({ entries: 4, packets: 1, totalLines: 950, mode: "whole" });
    // ids follow rank order, entries are sorted by `at`
    expect(b.packets[0]!.entries.map((e) => e.id)).toEqual(["E4", "E1", "E2", "E3"]);
  });

  test("packets hold at most 1800 lines unless one entry is larger", () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ file: `src/f${String(i).padStart(2, "0")}.ts`, text: lines(400) }));
    const b = wholeBundle(files);
    expect(b.packets.map((p) => p.name)).toEqual(["W1", "W2", "W3"]);
    for (let i = 0; i < b.packets.length; i++) expect(packetLines(b, i)).toBeLessThanOrEqual(BUNDLE_LIMITS.packetLines);
    expect(b.packets.map((p) => p.entries.length)).toEqual([4, 4, 4]);
  });

  test("chunk anchors sort as text, so a long file's later chunks can precede earlier ones", () => {
    const b = wholeBundle([{ file: "src/big.ts", text: lines(1300) }]);
    expect(b.packets[0]!.entries.map((e) => e.handler.start)).toEqual([1, 1201, 401, 801]);
  });

  test("hybrid keeps the slices first and adds only uncovered files within the remaining budget", () => {
    const span: Span = { key: "src/auth.ts:1", name: "requireUser", file: "src/auth.ts", start: 1, end: 10 };
    const base: Bundle = { packets: [{ name: "B1:src/routes.ts:3", shared: [span.key], entries: [entry("src/routes.ts:3", 3, 20)] }], spans: { [span.key]: span }, stats: { entries: 1, packets: 1, totalLines: 28 } };
    const b = wholeBundle(
      [
        { file: "src/routes.ts", text: lines(30, "req") },
        { file: "src/auth.ts", text: lines(30, "req") },
        { file: "src/other.ts", text: lines(100, "req") },
        { file: "src/last.ts", text: lines(100, "req") },
      ],
      { budget: 150, base },
    );
    expect(b.packets.map((p) => p.name)).toEqual(["B1:src/routes.ts:3", "W1"]);
    expect(b.packets[1]!.entries.map((e) => e.handler.file)).toEqual(["src/other.ts"]);
    expect(b.stats).toEqual({ entries: 1, packets: 2, totalLines: 128, mode: "hybrid" });
    expect(b.spans).toBe(base.spans);
  });
});

describe("cutSlicePackets", () => {
  test("shared spans count once per packet and the cut happens before an entry would pass the limit", () => {
    const g: Span = { key: "src/guard.ts:1", name: "requireOrg", file: "src/guard.ts", start: 1, end: 50 };
    const spans = new Map([[g.key, g]]);
    const entries = [entry("src/b.ts:1", 1, 40, { guards: [g.key] }), entry("src/a.ts:1", 1, 40, { guards: [g.key] }), entry("src/c.ts:1", 1, 40, { guards: [g.key] })];
    const b = cutSlicePackets(entries, spans, 140);
    // a (40) + guard (50) = 90; + b (40) = 130; + c (40) = 170 > 140: c starts a packet and brings the guard again.
    expect(b.packets.map((p) => p.entries.map((e) => e.at))).toEqual([["src/a.ts:1", "src/b.ts:1"], ["src/c.ts:1"]]);
    expect(b.packets.map((p) => p.shared)).toEqual([[g.key], [g.key]]);
    expect(b.packets.map((p) => p.name)).toEqual(["B1:src/a.ts:1", "B2:src/c.ts:1"]);
    expect(b.stats).toEqual({ entries: 3, packets: 2, totalLines: 220, mode: "slices" });
  });

  test("an entry bigger than the limit still gets its own packet", () => {
    const b = cutSlicePackets([entry("src/a.ts:1", 1, 3000), entry("src/b.ts:1", 1, 10)], new Map(), 1800);
    expect(b.packets.map((p) => p.entries.length)).toEqual([1, 1]);
  });
});

function fakeIndexer(data: { routes: unknown[]; defs: Record<string, unknown[]>; callees: Record<string, unknown> }) {
  return {
    async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
      if (tool === "routes") return { routes: data.routes } as T;
      if (tool === "definitions") return { definitions: data.defs[String(args.path)] ?? [] } as T;
      if (tool === "callees") return { definitions: data.callees[String(args.symbol)] ? [data.callees[String(args.symbol)]] : [] } as T;
      throw new Error(tool);
    },
  };
}

describe("sliceBundle", () => {
  const files: Record<string, string> = {
    "src/routes/items.ts": lines(600),
    "src/routes/small.ts": lines(30),
    "src/lib/auth.ts": lines(200),
  };
  const def = (name: string, file: string, line: number, endLine: number) => ({ name, file, line, endLine });
  const indexer = fakeIndexer({
    routes: [
      { method: "POST", path: "/items/:id", at: "src/routes/items.ts:12", chain: [], handlers: ["requireSession @ src/lib/auth.ts:5", "updateItem @ src/routes/items.ts:12"] },
      { method: "GET", path: "/items", at: "src/routes/items.ts:20", chain: [], handlers: [] },
      { method: "GET", path: "/health", at: "src/routes/small.ts:3", chain: [], handlers: [] },
      { method: "GET", path: "/t", at: "test/routes.ts:1", chain: [], handlers: [] },
    ],
    defs: {
      "src/routes/items.ts": [def("updateItem", "src/routes/items.ts", 12, 400)],
      "src/lib/auth.ts": [def("requireSession", "src/lib/auth.ts", 5, 120), def("checkOwner", "src/lib/auth.ts", 130, 150), def("format", "src/lib/auth.ts", 160, 170)],
    },
    callees: {
      updateItem: { definition: def("updateItem", "src/routes/items.ts", 12, 400), calls: [{ call: "checkOwner", definedAt: ["src/lib/auth.ts:130"] }, { call: "format", definedAt: ["src/lib/auth.ts:160"] }, { call: "db", definedAt: ["a.ts:1", "b.ts:1"] }] },
      checkOwner: { definition: def("checkOwner", "src/lib/auth.ts", 130, 150), calls: [{ call: "requireSession", definedAt: ["src/lib/auth.ts:5"] }] },
    },
  });

  test("handlers, guards and auth-shaped helpers become capped spans; duplicates and test paths are dropped", async () => {
    const b = await sliceBundle({ indexer, readFile: async (f) => files[f] });
    const es = b.packets.flatMap((p) => p.entries);
    expect(es.map((e) => [e.method, e.path, e.handler.start, e.handler.end])).toEqual([
      ["POST", "/items/:id", 12, 151],
      ["GET", "/health", 1, 31],
    ]);
    expect(es[0]!.guards).toEqual(["src/lib/auth.ts:5"]);
    expect(es[0]!.helpers).toEqual(["src/lib/auth.ts:130", "src/lib/auth.ts:5"]);
    expect(b.spans["src/lib/auth.ts:5"]).toEqual({ key: "src/lib/auth.ts:5", name: "requireSession", file: "src/lib/auth.ts", start: 5, end: 44 });
    expect(b.spans["src/lib/auth.ts:130"]!.end).toBe(150);
    expect(es[0]!.risk).toBe(1);
    expect(es[1]!.risk).toBe(2);
  });
});

describe("planBundle", () => {
  test("a small repository gets whole files even when the indexer fails", async () => {
    const files: Record<string, string> = { "src/a.ts": lines(10, "req"), "src/b.test.ts": lines(10), "docs/x.py": lines(10) };
    const plan = await planBundle({
      listFiles: async () => Object.keys(files),
      readFile: async (f) => files[f],
      indexer: { call: async () => Promise.reject(new Error("down")) },
    });
    expect(plan.mode).toBe("whole");
    expect(plan.serverLines).toBe(10);
    expect(plan.sliceEntries).toBe(0);
    expect(plan.bundle.packets.flatMap((p) => p.entries.map((e) => e.handler.file))).toEqual(["src/a.ts"]);
  });
});
