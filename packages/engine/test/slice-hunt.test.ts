import { describe, expect, test } from "bun:test";
import {
  addVotes,
  answerText,
  CHANGE_TASK,
  HUNT_TASK,
  huntMessages,
  lensTask,
  parseHuntReply,
  parseScoreReply,
  retryBatches,
  SCORE_TASK,
  scoreBatches,
  scoreMessages,
  type Cluster,
  type HuntRow,
  type Packet,
  type Span,
} from "../src/scan/slice";

const guard: Span = { key: "src/lib/auth.ts:2", name: "requireUser", file: "src/lib/auth.ts", start: 2, end: 3 };
const spans = { [guard.key]: guard };
const packet: Packet = {
  name: "B1:src/routes",
  shared: [guard.key],
  entries: [
    { id: "E1", method: "POST", path: "/items/:id", at: "src/routes/items.ts:4", handler: { key: "src/routes/items.ts:4", name: "update", file: "src/routes/items.ts", start: 4, end: 5 }, guards: [guard.key], helpers: [] },
    { id: "E2", method: "GET", path: "/items", at: "src/routes/items.ts:9", handler: { key: "src/routes/items.ts:9", name: "list", file: "src/routes/items.ts", start: 9, end: 9 }, guards: [], helpers: [] },
  ],
};
const files: Record<string, string[]> = {
  "src/lib/auth.ts": ["// auth", "export function requireUser(req) {", "  if (!req.user) throw 401; }"],
  "src/routes/items.ts": ["", "", "", "router.post('/items/:id', requireUser, async (req) => {", "  await db.items.update(req.params.id, req.body) });", "", "", "", "router.get('/items', list);"],
};
const linesOf = (f: string) => files[f] ?? [];

describe("huntMessages", () => {
  test("code first with line numbers, task last, same prefix for every pass and mode", () => {
    const generic = huntMessages(packet, spans, linesOf, "generic", 0)[0]!.content as string;
    const lens1 = huntMessages(packet, spans, linesOf, "lens", 1)[0]!.content as string;
    const change = huntMessages(packet, spans, linesOf, "change", 2)[0]!.content as string;
    const prefix = generic.slice(0, generic.length - HUNT_TASK.length);
    expect(generic.endsWith(HUNT_TASK)).toBe(true);
    expect(lens1).toBe(prefix + lensTask(1));
    expect(change).toBe(prefix + CHANGE_TASK);
    expect(prefix).toBe(
      [
        "Shared code (guards and helpers the entry points call):",
        "<f src/lib/auth.ts:2-3>",
        "2 export function requireUser(req) {",
        "3   if (!req.user) throw 401; }",
        "</f>",
        "",
        "Entry points:",
        "[E1] POST /items/:id",
        "<f src/routes/items.ts:4-5>",
        "4 router.post('/items/:id', requireUser, async (req) => {",
        "5   await db.items.update(req.params.id, req.body) });",
        "</f>",
        "[E2] GET /items",
        "<f src/routes/items.ts:9-9>",
        "9 router.get('/items', list);",
        "</f>",
        "",
        "",
      ].join("\n"),
    );
  });

  test("the three lenses differ and wrap around", () => {
    expect(new Set([0, 1, 2].map(lensTask)).size).toBe(3);
    expect(lensTask(3)).toBe(lensTask(0));
    expect(lensTask(0)).toContain("ACCESS CONTROL");
  });

  test("a packet with no shared code says so", () => {
    const content = huntMessages({ ...packet, shared: [] }, spans, linesOf, "generic", 0)[0]!.content as string;
    expect(content.startsWith("Shared code (guards and helpers the entry points call):\n(none)\n\nEntry points:\n")).toBe(true);
  });
});

describe("parseHuntReply", () => {
  test("keeps well-formed lines and tolerates fences, bullets, junk, missing fields and unknown entries", () => {
    const reply = [
      "Here are the findings:",
      "```",
      "E1|idor|a|src/routes/items.ts:5|other users|updates any item by id",
      "- E2 | authz | u | no location given | everyone",
      "* `E1|xss|u|src/views/item.ts:12|viewers|unescaped title`",
      "E3|idor|a|src/x.ts:1|users|unknown entry",
      "E1|idor|a",
      "NONE",
      "```",
      "",
    ].join("\n");
    const rows = parseHuntReply(reply, packet, 2);
    expect(rows.map((r) => [r.entry_id, r.kind, r.attacker, r.sink_file, r.sink_line, r.victim, r.why])).toEqual([
      ["E1", "idor", "a", "src/routes/items.ts", 5, "other users", "updates any item by id"],
      ["E2", "authz", "u", "src/routes/items.ts", 9, "everyone", ""],
      ["E1", "xss", "u", "src/views/item.ts", 12, "viewers", "unescaped title`"],
    ]);
    const first: HuntRow = rows[0]!;
    expect(first).toMatchObject({ packet: "B1:src/routes", pass: 2, role: "a", file: "src/routes/items.ts", line: 4, title: "idor in POST /items/:id" });
  });

  test("an empty or prose-only reply yields nothing", () => {
    expect(parseHuntReply("", packet, 0)).toEqual([]);
    expect(parseHuntReply("I could not find any issues | sorry", packet, 0)).toEqual([]);
  });

  test("answerText falls back to the last json block of the reasoning", () => {
    expect(answerText("E1|a", "```json x")).toBe("E1|a");
    expect(answerText("  ", "think ```json [1] ... ```json [2]")).toBe("```json [2]");
    expect(answerText("", "no block")).toBe("");
  });
});

const row = (over: Partial<HuntRow>): HuntRow => ({ packet: "P1", pass: 0, entry_id: "E1", kind: "idor", attacker: "a", role: "a", file: "src/a.ts", line: 1, sink_file: "src/a.ts", sink_line: 5, victim: "users", why: "no check", title: "t", ...over });
const cl = (packetName: string): Cluster => ({ file: "src/a.ts", line: 5, rows: [row({ packet: packetName })] });

describe("scoring", () => {
  test("scoreMessages lists candidates after the task, on the hunt's prefix", () => {
    const clusters = [cl("B1:src/routes"), cl("B1:src/routes")];
    const content = scoreMessages(packet, spans, linesOf, clusters, [1])[0]!.content as string;
    const hunt = huntMessages(packet, spans, linesOf, "generic", 0)[0]!.content as string;
    expect(content.startsWith(hunt.slice(0, hunt.length - HUNT_TASK.length))).toBe(true);
    expect(content.endsWith(`${SCORE_TASK}\n\nCandidates:\nC1|E1|idor|a|src/a.ts:5|users|no check`)).toBe(true);
  });

  test("parseScoreReply reads the last field as an integer and skips junk", () => {
    const reply = "```\nC0|7\n- C3 | E1 | 9\nC4|high\nC5|\nC6|8/9\nscore: C7|5\nC8 is 3\n```";
    expect(parseScoreReply(reply)).toEqual([
      { index: 0, score: 7 },
      { index: 3, score: 9 },
      { index: 4, score: 0 },
      { index: 5, score: 0 },
      { index: 6, score: 8 },
    ]);
  });

  test("votes accumulate as strings per candidate", () => {
    const votes: Record<number, string[]> = {};
    addVotes(votes, [{ index: 0, score: 7 }]);
    addVotes(votes, [{ index: 0, score: 3 }, { index: 2, score: 0 }]);
    expect(votes).toEqual({ 0: ["7", "3"], 2: ["0"] });
  });

  test("batches group by packet in first-seen order; the retry covers only unscored ones in half batches", () => {
    const clusters = ["P2", "P1", "P2", "P2", "P1", "P2"].map(cl);
    expect(scoreBatches(clusters, 2)).toEqual([
      { packet: "P2", ids: [0, 2] },
      { packet: "P2", ids: [3, 5] },
      { packet: "P1", ids: [1, 4] },
    ]);
    expect(retryBatches(clusters, { 0: ["1"], 4: ["2"] }, 4)).toEqual([
      { packet: "P2", ids: [2, 3] },
      { packet: "P2", ids: [5] },
      { packet: "P1", ids: [1] },
    ]);
    expect(retryBatches(clusters, {}, 1).length).toBe(6);
  });
});
