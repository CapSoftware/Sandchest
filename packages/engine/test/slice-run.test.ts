import { describe, expect, test } from "bun:test";
import { LlmError, LlmQuotaError, type ChatRequest, type ChatResult, type LlmClient } from "../src/llm";
import { UnpricedCallError, type UsageEvent } from "../src/scan/metrics";
import { CHANGE_TASK, changesFromDiff, HUNT_TASK, runChangeHunt, runSliceHunt, SCORE_TASK, type DevDef, type SliceHuntOptions } from "../src/scan/slice";

const fill = (n: number, line: (i: number) => string) => Array.from({ length: n }, (_, i) => line(i + 1)).join("\n") + "\n";

/** A small invented service: whole-file mode, one packet. `charge` is the only billing handler without a member check. */
const BILLING = [
  "export async function charge(req) {",
  ...Array.from({ length: 8 }, (_, i) => `  const amount${i} = req.body.amount;`),
  "}",
  "export async function refund(req) {",
  "  requireMember(req);",
  ...Array.from({ length: 4 }, () => "  const total = req.body.total;"),
  "}",
  "export async function invoices(req) {",
  "  requireMember(req);",
  ...Array.from({ length: 4 }, () => "  const list = req.query.list;"),
  "}",
  "export async function exportCsv(req) {",
  "  requireMember(req);",
  ...Array.from({ length: 3 }, () => "  const rows = req.query.rows;"),
  "}",
].join("\n");
const REPO: Record<string, string> = {
  "src/api/users.ts": fill(40, (i) => `const user${i} = req.params.id;`),
  "src/api/billing.ts": BILLING + "\n",
  "src/lib/auth.ts": fill(20, (i) => `const token${i} = req.session.token;`),
  "src/api/users.test.ts": fill(5, () => "test();"),
  "README.md": "acme/api\n",
};
const DEFS: Record<string, DevDef[]> = {
  "src/api/billing.ts": [
    { name: "charge", file: "src/api/billing.ts", line: 1, endLine: 10 },
    { name: "refund", file: "src/api/billing.ts", line: 11, endLine: 17 },
    { name: "invoices", file: "src/api/billing.ts", line: 18, endLine: 24 },
    { name: "exportCsv", file: "src/api/billing.ts", line: 25, endLine: 30 },
  ],
};

type Row = [file: string, kind: string, attacker: string, line: number, victim: string, why: string];
/** Hunt rows per pass, by file; each becomes `E<n>|...` for the entry showing that file. */
const HUNT: Row[][] = [
  [
    ["src/api/users.ts", "idor", "a", 12, "other users", "reads any user by id"],
    ["src/api/billing.ts", "billing", "u", 8, "the operator", "charges with no member check"],
  ],
  [
    ["src/api/users.ts", "idor", "a", 14, "other users", "id from the request"],
    ["src/lib/auth.ts", "auth", "u", 5, "every account", "token never compared"],
  ],
  [
    ["src/api/users.ts", "idor", "a", 12, "other users", "no owner check"],
    ["src/api/billing.ts", "sqli", "a", 25, "all tenants", "rows reach raw query"],
  ],
];
/** Scores per sink, one per time the candidate is asked about; undefined leaves it out of the reply. */
const SCORES: Record<string, Array<number | undefined>> = {
  "src/lib/auth.ts:5": [9, 2, 2],
  "src/api/users.ts:12": [4, 4, 4],
  "src/api/billing.ts:8": [3, 3, 3],
  "src/api/billing.ts:25": [undefined, undefined, undefined, 5],
};

const usage = { inputTokens: 100, cachedTokens: 80, outputTokens: 10, reasoningTokens: 0 };
const reply = (content: string, costUsd?: number): ChatResult => ({
  content,
  reasoning: "",
  toolCalls: [],
  finishReason: "stop",
  usage,
  ...(costUsd !== undefined && { costUsd }),
  message: { role: "assistant", content: content || null },
  retries: 0,
});

const contentOf = (r: ChatRequest) => (r.messages[0] as { content: string }).content;
const isScore = (r: ChatRequest) => contentOf(r).includes(SCORE_TASK);

interface Fake extends LlmClient {
  requests: ChatRequest[];
  /** Most calls in flight at once. */
  peak: number;
}

/**
 * A client that answers hunt and score prompts from the tables above. The reply is chosen when the call
 * starts (by how often the same prompt or candidate was asked before), then `delay` decides when it lands.
 * `fail(request, k)` may return an error to throw instead (k: calls before this one).
 */
function fakeClient(options: { hunt?: Row[][]; scores?: Record<string, Array<number | undefined>>; delay?: () => number; fail?: (r: ChatRequest, k: number) => unknown; costUsd?: number; onChat?: (r: ChatRequest) => Promise<void> | void } = {}): Fake {
  const hunt = options.hunt ?? HUNT;
  const scores = options.scores ?? SCORES;
  const asked = new Map<string, number>();
  const requests: ChatRequest[] = [];
  const count = (key: string) => {
    const n = asked.get(key) ?? 0;
    asked.set(key, n + 1);
    return n;
  };
  const answer = (r: ChatRequest) => {
    const content = contentOf(r);
    if (isScore(r)) {
      const out: string[] = [];
      for (const line of content.slice(content.indexOf("Candidates:\n")).split("\n")) {
        const m = line.match(/^C(\d+)\|[^|]*\|[^|]*\|[^|]*\|([^|]+)\|/);
        if (!m) continue;
        const s = scores[m[2]!]?.[count(m[2]!)];
        if (s !== undefined) out.push(`C${m[1]}|${s}`);
      }
      return out.join("\n");
    }
    const pass = count(content);
    const ids = new Map([...content.matchAll(/^\[(E\d+)\] \S+ (\S+)/gm)].map((m) => [m[2]!, m[1]!]));
    const rows = (hunt[pass] ?? []).filter(([file]) => ids.has(file)).map(([file, kind, att, line, victim, why]) => `${ids.get(file)}|${kind}|${att}|${file}:${line}|${victim}|${why}`);
    return rows.length ? rows.join("\n") : "NONE";
  };
  let active = 0;
  const fake: Fake = {
    config: { baseUrl: "http://fake", apiKey: "k", model: "m" },
    requests,
    peak: 0,
    async chat(request) {
      const k = requests.length;
      requests.push(request);
      fake.peak = Math.max(fake.peak, ++active);
      try {
        const error = options.fail?.(request, k);
        const text = error === undefined ? answer(request) : "";
        await options.onChat?.(request);
        const ms = options.delay?.() ?? 0;
        if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
        if (error !== undefined) throw error;
        return reply(text, options.costUsd);
      } finally {
        active--;
      }
    },
  };
  return fake;
}

function repoOptions(client: LlmClient, extra: Partial<SliceHuntOptions> = {}): SliceHuntOptions {
  return {
    client,
    listFiles: async () => Object.keys(REPO),
    readFile: async (f) => REPO[f],
    indexer: {
      call: async <T>(tool: string, args: Record<string, unknown> = {}) =>
        (tool === "routes" ? { routes: [] } : { definitions: DEFS[String(args.path)] ?? [] }) as T,
    },
    passDelayMs: 0,
    ...extra,
  };
}

const hunts = (c: Fake) => c.requests.filter((r) => !isScore(r));
const scoreCalls = (c: Fake) => c.requests.filter(isScore);

describe("runSliceHunt", () => {
  test("hunts x3, scores x3 with one retry, dedupes and ranks by score interleaved with deviance", async () => {
    const client = fakeClient();
    const progress: string[] = [];
    const out = await runSliceHunt(repoOptions(client, { onProgress: (m) => progress.push(m) }));

    expect(out.bundle).toEqual({ files: 3, lines: 90, mode: "whole" });
    expect(out.counts).toEqual({ packets: 1, huntCalls: 3, huntFailed: 0, scoreCalls: 4, scoreFailed: 0, rows: 6, clusters: 4, kept: 4, selected: 4 });
    // auth and the sqli lead on score; the billing handler that skips the check its siblings make jumps the idor.
    expect(out.findings.map((f) => [f.id, f.dedup, f.sink])).toEqual([
      ["F1", 0, "src/lib/auth.ts:5"],
      ["F2", 1, "src/api/billing.ts:25"],
      ["F3", 3, "src/api/billing.ts:8"],
      ["F4", 2, "src/api/users.ts:12"],
    ]);
    expect(out.findings[0]).toEqual({ id: "F1", dedup: 0, title: "auth in FILE src/lib/auth.ts", attacker: "unauthenticated", entry: "src/lib/auth.ts:1", sink: "src/lib/auth.ts:5", why: "auth: token never compared (harms: every account)" });
    expect(out.candidates.map((c) => c.a)).toEqual([[9, 2, 2], [5], [3, 3, 3], [4, 4, 4]]);
    expect(out.candidates[3]!.merged).toHaveLength(3);
    expect(progress).toHaveLength(3);

    // Reasoning off, the measured token limits, one user message with the code first and the task last.
    for (const r of hunts(client)) {
      expect(r).toMatchObject({ role: "hunt", reasoningEffort: null, maxTokens: 3000 });
      expect(r.messages).toHaveLength(1);
      expect(contentOf(r).startsWith("Shared code")).toBe(true);
      expect(contentOf(r).endsWith(HUNT_TASK)).toBe(true);
    }
    for (const r of scoreCalls(client)) expect(r).toMatchObject({ role: "skeptic", reasoningEffort: null, maxTokens: 4000 });
    // The retry asks only about the cluster that got no vote.
    expect(contentOf(scoreCalls(client)[3]!).split("Candidates:\n")[1]!.split("\n")).toHaveLength(1);
  });

  test("a failed hunt call loses that pass only and is counted", async () => {
    const client = fakeClient({ fail: (r, k) => (!isScore(r) && k === 1 ? new LlmError("bad gateway", { retryable: true, status: 502 }) : undefined) });
    const out = await runSliceHunt(repoOptions(client, { concurrency: 1 }));
    expect(out.counts).toMatchObject({ huntCalls: 3, huntFailed: 1, rows: 4 });
    expect(out.findings.length).toBeGreaterThan(0);
  });

  test("when every hunt call fails the run throws instead of looking clean", async () => {
    const client = fakeClient({ fail: (r) => (isScore(r) ? undefined : new Error("bad reply")) });
    await expect(runSliceHunt(repoOptions(client))).rejects.toThrow("Every hunt call failed (3 calls)");
    expect(scoreCalls(client)).toHaveLength(0);
  });

  test("when every scoring call fails the run throws", async () => {
    const client = fakeClient({ fail: (r) => (isScore(r) ? new Error("bad reply") : undefined) });
    await expect(runSliceHunt(repoOptions(client))).rejects.toThrow("Every scoring call failed (4 calls)");
  });

  test("an empty reply is a pass with no findings, not a failure", async () => {
    const client = fakeClient({ hunt: [[], [], []] });
    const out = await runSliceHunt(repoOptions(client));
    expect(out.counts).toMatchObject({ huntCalls: 3, huntFailed: 0, rows: 0, clusters: 0, scoreCalls: 0, selected: 0 });
    expect(out.findings).toEqual([]);
  });

  test("a fatal error stops the run, and no further call is made", async () => {
    const quota = new LlmQuotaError("out of credit", { status: 402, retryable: false });
    const client = fakeClient({ fail: () => quota });
    await expect(runSliceHunt(repoOptions(client, { concurrency: 1 }))).rejects.toBe(quota);
    expect(client.requests).toHaveLength(1);
  });

  test("a fatal error cancels calls already in flight", async () => {
    const quota = new LlmQuotaError("out of credit", { status: 402, retryable: false });
    const cancelled: unknown[] = [];
    let calls = 0;
    const client = fakeClient({
      onChat: (r) =>
        calls++ === 0
          ? Promise.reject(quota)
          : new Promise<void>((_, reject) => r.signal!.addEventListener("abort", () => (cancelled.push(r.signal!.reason), reject(r.signal!.reason)))),
    });
    await expect(runSliceHunt(repoOptions(client))).rejects.toBe(quota);
    expect(client.requests).toHaveLength(3);
    expect(cancelled).toEqual([quota, quota]);
  });

  test("an abort stops the run with its reason", async () => {
    const controller = new AbortController();
    const client = fakeClient({
      onChat: (r) => {
        controller.abort(new Error("Interrupted"));
        throw r.signal!.reason;
      },
    });
    await expect(runSliceHunt(repoOptions(client, { signal: controller.signal, concurrency: 1 }))).rejects.toThrow("Interrupted");
    expect(client.requests).toHaveLength(1);

    const before = fakeClient();
    await expect(runSliceHunt(repoOptions(before, { signal: AbortSignal.abort(new Error("Interrupted")) }))).rejects.toThrow("Interrupted");
    expect(before.requests).toHaveLength(0);
  });

  test("a packet's later passes start once its first has ended, well before the full delay", async () => {
    const inner = fakeClient({ delay: () => 5 });
    const seen = new Set<string>();
    const ended = new Set<string>();
    let early = 0;
    // Every pass of a packet sends the same prompt, so the prompt names the packet.
    const client: LlmClient = {
      ...inner,
      async chat(request) {
        const packet = contentOf(request);
        if (!isScore(request)) {
          if (seen.has(packet) && !ended.has(packet)) early++;
          seen.add(packet);
        }
        try {
          return await inner.chat(request);
        } finally {
          if (!isScore(request)) ended.add(packet);
        }
      },
    };
    const started = Date.now();
    const out = await runSliceHunt(repoOptions(client, { passDelayMs: 60_000 }));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(early).toBe(0);
    expect(hunts(inner)).toHaveLength(out.counts.packets * 3);
    expect(out.counts.huntFailed).toBe(0);
  });

  test("later passes still run when a packet's first pass failed", async () => {
    const client = fakeClient({ fail: (r, k) => (k === 0 && !isScore(r) ? new Error("upstream 500") : undefined) });
    const started = Date.now();
    const out = await runSliceHunt(repoOptions(client, { passDelayMs: 60_000 }));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out.counts.huntFailed).toBe(1);
    expect(hunts(client)).toHaveLength(out.counts.packets * 3);
  });

  test("an abort during the wait between passes stops the run", async () => {
    const controller = new AbortController();
    const client = fakeClient({ onChat: () => controller.abort(new Error("Interrupted")) });
    await expect(runSliceHunt(repoOptions(client, { signal: controller.signal, passDelayMs: 60_000 }))).rejects.toThrow("Interrupted");
    expect(client.requests).toHaveLength(1);
  });

  test("every call reaches the sink with its stage and role, failed ones too", async () => {
    const events: UsageEvent[] = [];
    const client = fakeClient({ fail: (r, k) => (k === 0 ? new LlmError("bad gateway", { retryable: true, status: 502 }) : undefined) });
    const out = await runSliceHunt(repoOptions(client, { concurrency: 1, onUsage: (e) => events.push(e), pricing: { input: 2, cachedInput: 0.5, output: 8 } }));
    expect(events).toHaveLength(client.requests.length);
    expect(events.map((e) => [e.stage, e.role, e.status])).toEqual([
      ["slice_hunt", "hunt", "failed"],
      ["slice_hunt", "hunt", "ok"],
      ["slice_hunt", "hunt", "ok"],
      ...Array.from({ length: out.counts.scoreCalls }, () => ["slice_score", "skeptic", "ok"]),
    ]);
    expect(events[1]!.costUsd).toBeGreaterThan(0);
  });

  test("with a cost required, an unpriced call stops the run", async () => {
    const events: UsageEvent[] = [];
    const client = fakeClient();
    await expect(runSliceHunt(repoOptions(client, { concurrency: 1, requireCost: true, onUsage: (e) => events.push(e) }))).rejects.toBeInstanceOf(UnpricedCallError);
    expect(client.requests).toHaveLength(1);
    expect(events.map((e) => [e.stage, e.status])).toEqual([["slice_hunt", "unpriced"]]);

    const priced = await runSliceHunt(repoOptions(fakeClient({ costUsd: 0.001 }), { requireCost: true }));
    expect(priced.counts.selected).toBe(4);
  });

  describe("selection", () => {
    /** 70 handler files, each with one candidate of its own; the score falls with the file's number. */
    const files = Array.from({ length: 70 }, (_, i) => `src/api/h${String(i + 1).padStart(2, "0")}.ts`);
    const wide = {
      listFiles: async () => files,
      readFile: async (f: string) => (files.includes(f) ? "export async function handler(req) {\n  return db.items.find(req.params.id);\n}\n" : undefined),
    };
    const hunt: Row[][] = [files.map((f): Row => [f, "idor", "a", 2, "other users", "no owner check"]), [], []];
    const scores = Object.fromEntries(files.map((f, i) => [`${f}:2`, Array.from({ length: 3 }, () => 9 - Math.floor(i / 8))]));
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `F${i + 1}`);

    test("up to two bands of 30, numbered F1 to F60 in rank order", async () => {
      const out = await runSliceHunt(repoOptions(fakeClient({ hunt, scores }), wide));
      expect(out.counts).toMatchObject({ clusters: 70, kept: 70, selected: 60 });
      expect(out.findings.map((f) => f.id)).toEqual(ids(60));
      // Best-scored first, and each entry describes the candidate beside it.
      expect(out.findings.map((f) => f.sink)).toEqual(files.slice(0, 60).map((f) => `${f}:2`));
      expect(out.candidates.map((c) => `${c.rows[0]!.sink_file}:${c.rows[0]!.sink_line}`)).toEqual(out.findings.map((f) => f.sink));
    });

    test("`top` sets the most selected, and a smaller selection is the start of a larger one", async () => {
      const all = await runSliceHunt(repoOptions(fakeClient({ hunt, scores }), wide));
      const band = await runSliceHunt(repoOptions(fakeClient({ hunt, scores }), { ...wide, top: 30 }));
      expect(band.counts.selected).toBe(30);
      expect(band.findings).toEqual(all.findings.slice(0, 30));
      expect(band.candidates).toEqual(all.candidates.slice(0, 30));
      const few = await runSliceHunt(repoOptions(fakeClient({ hunt, scores }), { ...wide, top: 7 }));
      expect(few.findings.map((f) => f.id)).toEqual(ids(7));
      // Fewer candidates than `top`: all of them.
      const more = await runSliceHunt(repoOptions(fakeClient({ hunt, scores }), { ...wide, top: 500 }));
      expect(more.findings.map((f) => f.id)).toEqual(ids(70));
    });
  });

  test("the same replies give the same result whatever order the calls finish in", async () => {
    const plain = await runSliceHunt(repoOptions(fakeClient()));
    for (let run = 0; run < 5; run++) {
      const client = fakeClient({ delay: () => Math.floor(Math.random() * 15) });
      const shuffled = await runSliceHunt(repoOptions(client, { concurrency: 2 }));
      expect(shuffled).toEqual(plain);
      expect(client.peak).toBe(2);
    }
  });
});

describe("runChangeHunt", () => {
  const FILE = "src/api/v2/organizations/members/invitations/handlers/orders-and-refunds.ts";
  const text = fill(60, (i) => `const order${i} = req.body.order;`);
  const numstat = [`12\t3\t${FILE}`, "5\t0\tweb/components/Button.tsx", "-\t-\tassets/logo.png", "0\t4\tsrc/api/old.ts"].join("\n");
  const diff = [`diff --git a/${FILE} b/${FILE}`, `--- a/${FILE}`, `+++ b/${FILE}`, "@@ -10,2 +10,12 @@", "+x", "diff --git a/src/api/old.ts b/src/api/old.ts", "+++ b/src/api/old.ts", "@@ -3,4 +2,0 @@"].join("\n");
  const hunt: Row[][] = [
    [
      [FILE, "idor", "a", 15, "other orgs", "order id not scoped"],
      [FILE, "sqli", "u", 50, "all tenants", "raw filter in query"],
    ],
    [
      [FILE, "idor", "m", 16, "other orgs", "role not checked"],
      [FILE, "ssrf", "a", 28, "internal hosts", "callback url fetched"],
    ],
    [],
  ];
  const scores = { [`${FILE}:15`]: [8, 7, 8], [`${FILE}:50`]: [9, 9, 9], [`${FILE}:28`]: [1, 1, 1] };

  test("changed server files only, change-review task, candidates on changed lines scoring 2 or more", async () => {
    const client = fakeClient({ hunt, scores });
    const reads: string[] = [];
    const out = await runChangeHunt({ client, numstat, diff, readFile: async (f) => (reads.push(f), f === FILE ? text : undefined), passDelayMs: 0 });

    // Only the changed server file is read (once for the bundle, once for the packet code).
    expect(new Set(reads)).toEqual(new Set([FILE]));
    // A change counts newlines plus one, so the final newline adds a line.
    expect(out.bundle).toEqual({ files: 1, lines: 61, mode: "change" });
    expect(out.counts).toEqual({ packets: 1, huntCalls: 3, huntFailed: 0, scoreCalls: 3, scoreFailed: 0, rows: 4, clusters: 3, kept: 3, selected: 1 });
    for (const r of hunts(client)) {
      expect(r).toMatchObject({ role: "hunt", reasoningEffort: null, maxTokens: 3000 });
      expect(contentOf(r).endsWith(CHANGE_TASK)).toBe(true);
      expect(contentOf(r)).toContain(`[E1] CHANGED ${FILE} (changed lines: 10-21)`);
    }
    // The 9 at line 50 is outside the change, the ssrf at 28 is in it but scores 1.
    expect(out.findings).toEqual([
      {
        id: "F1",
        dedup: 0,
        title: `idor in CHANGED ${FILE} (changed lines: 10-21)`.slice(0, 100),
        attacker: "any_user",
        entry: `${FILE}:1`,
        sink: `${FILE}:15`,
        why: "idor: order id not scoped (harms: other orgs)",
      },
    ]);
    expect(out.findings[0]!.title).toHaveLength(100);
    expect(out.candidates[0]!.merged).toHaveLength(2);
  });

  test("already-parsed changes give the same result, with the same calls, as the diff text", async () => {
    const textOf = async (f: string) => (f === FILE ? text : undefined);
    const fromDiff = fakeClient({ hunt, scores });
    const viaDiff = await runChangeHunt({ client: fromDiff, numstat, diff, readFile: textOf, passDelayMs: 0 });
    const parsed = fakeClient({ hunt, scores });
    const reads: string[] = [];
    const changes = [
      { path: FILE, additions: 12, ranges: [[10, 21]] as Array<[number, number]> },
      { path: "web/components/Button.tsx", additions: 5, ranges: [[1, 5]] as Array<[number, number]> },
      { path: "src/api/old.ts", additions: 0, ranges: [] },
    ];
    const viaChanges = await runChangeHunt({ client: parsed, changes, readFile: async (f) => (reads.push(f), textOf(f)), passDelayMs: 0 });
    expect(viaChanges).toEqual(viaDiff);
    expect(viaChanges.counts.selected).toBe(1);
    expect(parsed.requests.map(contentOf)).toEqual(fromDiff.requests.map(contentOf));
    expect(new Set(reads)).toEqual(new Set([FILE]));
    // The diff text parses to the same changes, binary files left out.
    expect(changesFromDiff(numstat, diff)).toEqual([changes[0]!, { ...changes[1]!, ranges: [] }, changes[2]!]);

    // A server file with no changed ranges, or whose text cannot be read, is left out as it is from diff text.
    const none = fakeClient({ hunt, scores });
    const out = await runChangeHunt({ client: none, changes: [{ path: FILE, additions: 3, ranges: [] }, { path: "src/api/gone.ts", additions: 2, ranges: [[1, 2]] }], readFile: textOf, passDelayMs: 0 });
    expect(none.requests).toHaveLength(0);
    expect(out.bundle).toEqual({ files: 0, lines: 0, mode: "change" });
  });

  test("a change selects 12 at most, as before: it has no second band", async () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/api/c${String(i + 1).padStart(2, "0")}.ts`);
    const out = await runChangeHunt({
      client: fakeClient({ hunt: [files.map((f): Row => [f, "idor", "a", 2, "other orgs", "id not scoped"]), [], []], scores: Object.fromEntries(files.map((f) => [`${f}:2`, [8, 8, 8]])) }),
      changes: files.map((f) => ({ path: f, additions: 3, ranges: [[1, 3]] as Array<[number, number]> })),
      readFile: async () => "export async function handler(req) {\n  return db.items.find(req.params.id);\n}\n",
      passDelayMs: 0,
    });
    expect(out.counts).toMatchObject({ kept: 20, selected: 12 });
    expect(out.findings.map((f) => f.id)).toEqual(Array.from({ length: 12 }, (_, i) => `F${i + 1}`));
  });

  test("a change with no server code makes no call", async () => {
    const client = fakeClient();
    const out = await runChangeHunt({ client, numstat: "5\t0\tweb/components/Button.tsx", diff: "", readFile: async () => "x", passDelayMs: 0 });
    expect(client.requests).toHaveLength(0);
    expect(out.counts).toMatchObject({ packets: 0, huntCalls: 0, selected: 0 });
    expect(out.bundle).toEqual({ files: 0, lines: 0, mode: "change" });
  });
});
