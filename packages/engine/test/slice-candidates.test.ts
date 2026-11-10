import { describe, expect, test } from "bun:test";
import { cluster, dedupe, normKind, spots, topK, votesOf, type Candidate, type HuntRow } from "../src/scan/slice";

let n = 0;
const row = (over: Partial<HuntRow>): HuntRow => ({ packet: "P1", pass: 0, entry_id: "E1", kind: "idor", attacker: "a", role: "a", file: "src/routes.ts", line: 1, sink_file: "src/a.ts", sink_line: 10, victim: "users", why: `w${n++}`, title: "t", ...over });

describe("spots", () => {
  test("entry then sink, leading dots and slashes stripped, missing or zero lines dropped", () => {
    expect(spots(row({ file: "./src/r.ts", line: 3, sink_file: "/src/a.ts", sink_line: 9 }))).toEqual([
      ["src/r.ts", 3],
      ["src/a.ts", 9],
    ]);
    expect(spots({ file: ".github/x.ts", line: "12", sink_file: "src/a.ts", sink_line: 0 })).toEqual([["github/x.ts", 12]]);
    expect(spots({ file: "", line: 4, sink_file: "src/a.ts", sink_line: "x" })).toEqual([]);
    expect(spots({ sink_file: "src/a.ts", sink_line: 7.9 })).toEqual([["src/a.ts", 7]]);
  });
});

describe("cluster", () => {
  test("joins rows within 10 lines of a cluster's first row, by the last spot", () => {
    const rows = [row({ sink_line: 10 }), row({ sink_line: 20 }), row({ sink_line: 21 }), row({ sink_line: 0, line: 15, file: "src/a.ts" }), row({ sink_file: "src/b.ts", sink_line: 10 })];
    const cs = cluster(rows);
    expect(cs.map((c) => [c.file, c.line, c.rows.length])).toEqual([
      ["src/a.ts", 10, 3],
      ["src/a.ts", 21, 1],
      ["src/b.ts", 10, 1],
    ]);
  });

  test("orders by distinct passes, ties keep first-seen order", () => {
    const rows = [row({ sink_line: 100, pass: 0 }), row({ sink_line: 100, pass: 0 }), row({ sink_line: 200, pass: 0 }), row({ sink_line: 200, pass: 1 }), row({ sink_line: 300, pass: 2 }), row({ sink_line: 300, pass: 1 }), row({ sink_line: 300, pass: 0 })];
    expect(cluster(rows).map((c) => c.line)).toEqual([300, 200, 100]);
    const ties = [row({ sink_line: 50 }), row({ sink_line: 5 }), row({ sink_line: 500 })];
    expect(cluster(ties).map((c) => c.line)).toEqual([50, 5, 500]);
  });
});

describe("normKind", () => {
  test("folds kinds into four families", () => {
    expect(["SQLi", "command injection", "SSRF", "stored xss", "idor", "", undefined].map(normKind)).toEqual(["sqli", "sqli", "ssrf", "xss", "authz", "authz", "authz"]);
  });
});

describe("dedupe", () => {
  const c = (sink_line: number, kind = "idor", rows = 1, sink_file = "src/a.ts") => ({ file: sink_file, line: sink_line, rows: Array.from({ length: rows }, () => row({ sink_line, kind, sink_file })) });

  test("best-scored first; near repeats of the same family merge into the representative", () => {
    const cs = [c(100), c(130, "authz"), c(141), c(120, "sql injection"), c(300)];
    const scores = { "0": { votes: ["3", "3", "3"] }, "1": { votes: ["5", "1", "1"] }, "2": { votes: ["9", "0", "0"] }, "3": { votes: ["2"] } };
    const kept = dedupe(cs, scores);
    // Order: 2 (max 9), 1 (max 5), 0 (max 3), 3 (max 2), 4 (no votes: 0).
    // 1 merges into 2 (11 lines, same family); 0 is 41 lines from 141 so it stays; 3 is another family.
    expect(kept.map((k) => k.orig)).toEqual([2, 0, 3, 4]);
    expect(kept[0]!.merged.map((r) => r.sink_line)).toEqual([141, 130]);
    expect(kept[0]!.a).toEqual([9, 0, 0]);
    expect(kept[3]!.a).toEqual([0]);
  });

  test("compares only with kept representatives, and ties keep cluster order", () => {
    const cs = [c(100), c(141), c(181)];
    const kept = dedupe(cs, {});
    expect(kept.map((k) => k.orig)).toEqual([0, 1]);
    expect(kept[1]!.merged.map((r) => r.sink_line)).toEqual([141, 181]);
    const byRows = dedupe([c(100, "idor", 1), c(500, "idor", 3), c(900, "idor", 2)], {});
    expect(byRows.map((k) => k.orig)).toEqual([1, 2, 0]);
  });

  test("votesOf defaults to a single zero", () => {
    expect(votesOf({}, 4)).toEqual([0]);
    expect(votesOf({ "4": { votes: [] } }, 4)).toEqual([0]);
    expect(votesOf({ "4": { votes: ["7", 2] } }, 4)).toEqual([7, 2]);
  });
});

describe("topK", () => {
  const cand = (a: number[], merged = 1): Candidate => {
    const rows = [row({})];
    return { rows, merged: Array.from({ length: merged }, () => rows[0]!), orig: 0, a };
  };

  test("interleaves the score order with the score + deviance order, skipping repeats", () => {
    const kept = [cand([5, 5, 5]), cand([5, 4, 4]), cand([3, 3, 3]), cand([2, 2, 2]), cand([1, 1, 1])];
    const dev = { "3": { dev: 1, noAuth: true, sibAuthShare: 1 }, "4": { dev: 0.5 } };
    // By score: 0, 1, 2, 3, 4. By deviance: 3 (2+3+1.5=6.5), 0 (5), 1 (5, lower mean), 2 (3), 4 (1+1.5=2.5).
    expect(topK(kept, dev, 5)).toEqual([0, 3, 1, 2, 4]);
    expect(topK(kept, dev, 2)).toEqual([0, 3]);
    expect(topK(kept, dev, 3, new Set([0]))).toEqual([1, 3, 2]);
  });

  test("ties fall back to more merged rows, then input order", () => {
    const kept = [cand([4], 1), cand([4], 3), cand([4], 1)];
    expect(topK(kept, {}, 3)).toEqual([1, 0, 2]);
  });

  test("k larger than the list returns everything once", () => {
    const kept = [cand([1]), cand([2])];
    expect(topK(kept, {}, 30)).toEqual([1, 0]);
    expect(topK([], {}, 30)).toEqual([]);
  });
});
