import { describe, expect, test } from "bun:test";
import { changeBundle, changeCandidates, changedServerPaths, changeRegions, inDiff, parseDiffHunks, parseNumstat, type Cluster, type HuntRow } from "../src/scan/slice";

const text = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("diff parsing", () => {
  test("numstat rows skip binary files", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\n-\t-\tlogo.png\n0\t4\tsrc/b.ts\n")).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1 },
      { path: "src/b.ts", additions: 0, deletions: 4 },
    ]);
  });

  test("changed server paths need added lines and a server path", () => {
    expect(changedServerPaths([{ path: "src/a.ts", additions: 3 }, { path: "src/b.ts", additions: 0 }, { path: "src/x.test.ts", additions: 5 }, { path: "apps/desktop/main.ts", additions: 2 }, { path: "src/lib/form.tsx", additions: 2 }])).toEqual(["src/a.ts"]);
  });

  test("new-side ranges per file; pure deletions are left out", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,0 +11,3 @@ function x() {",
      "+a",
      "@@ -40 +43 @@",
      "@@ -50,2 +53,0 @@",
      "diff --git a/src/b.ts b/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1 +1,2 @@",
    ].join("\n");
    expect([...parseDiffHunks(diff)]).toEqual([
      [
        "src/a.ts",
        [
          [11, 13],
          [43, 43],
        ],
      ],
      ["src/b.ts", [[1, 2]]],
    ]);
  });
});

describe("changeRegions", () => {
  test("a file of 500 lines or fewer is shown whole", () => {
    expect(changeRegions(500, [[300, 301]])).toEqual([[1, 500]]);
  });

  test("hunks get 120 lines each side, touching windows merge, long regions split at 500", () => {
    expect(
      changeRegions(2000, [
        [1000, 1000],
        [200, 210],
        [450, 455],
      ]),
    ).toEqual([
      [80, 575],
      [880, 1120],
    ]);
    expect(changeRegions(5000, [[1000, 1700]])).toEqual([
      [880, 1379],
      [1380, 1820],
    ]);
    expect(changeRegions(800, [[790, 800]])).toEqual([[670, 800]]);
  });
});

describe("changeBundle", () => {
  test("one entry per region with changed lines, headed by the ranges, packets of up to 1800 lines", () => {
    const { bundle, hunks } = changeBundle([
      { file: "src/small.ts", text: text(100), hunks: [[5, 5], [20, 24]] },
      { file: "src/big.ts", text: text(3000), hunks: [[1000, 1002], [2500, 2500]] },
      { file: "src/none.ts", text: text(10), hunks: [] },
      ...Array.from({ length: 4 }, (_, i) => ({ file: `src/f${i}.ts`, text: text(450), hunks: [[1, 1]] as Array<[number, number]> })),
    ]);
    const entries = bundle.packets.flatMap((p) => p.entries);
    expect(entries.map((e) => [e.id, e.path, e.handler.start, e.handler.end])).toEqual([
      ["E1", "src/small.ts (changed lines: 5, 20-24)", 1, 100],
      ["E2", "src/big.ts (changed lines: 1000-1002)", 880, 1122],
      ["E3", "src/big.ts (changed lines: 2500)", 2380, 2620],
      ["E4", "src/f0.ts (changed lines: 1)", 1, 450],
      ["E5", "src/f1.ts (changed lines: 1)", 1, 450],
      ["E6", "src/f2.ts (changed lines: 1)", 1, 450],
      ["E7", "src/f3.ts (changed lines: 1)", 1, 450],
    ]);
    expect(entries[0]!.method).toBe("CHANGED");
    expect(entries[0]!.hunks).toEqual([
      [5, 5],
      [20, 24],
    ]);
    // 100 + 243 + 241 + 450 + 450 = 1484; the next 450 would pass 1800.
    expect(bundle.packets.map((p) => [p.name, p.entries.length])).toEqual([
      ["P1", 5],
      ["P2", 2],
    ]);
    expect(bundle.stats).toEqual({ entries: 7, packets: 2, totalLines: 100 + 243 + 241 + 4 * 450 });
    expect([...hunks.keys()]).toEqual(["src/small.ts", "src/big.ts", "src/f0.ts", "src/f1.ts", "src/f2.ts", "src/f3.ts"]);
  });

  test("a range clipped by a split region shows only its part", () => {
    const { bundle } = changeBundle([{ file: "src/a.ts", text: text(5000), hunks: [[1000, 1700]] }]);
    expect(bundle.packets[0]!.entries.map((e) => e.path)).toEqual(["src/a.ts (changed lines: 1000-1379)", "src/a.ts (changed lines: 1380-1700)"]);
  });
});

const row = (over: Partial<HuntRow>): HuntRow => ({ packet: "P1", pass: 0, entry_id: "E1", kind: "idor", attacker: "a", role: "a", file: "src/a.ts", line: 1, sink_file: "src/a.ts", sink_line: 10, victim: "users", why: "w", title: "t", ...over });
const c = (sink_line: number, kind = "idor", sink_file = "src/a.ts"): Cluster => ({ file: sink_file, line: sink_line, rows: [row({ sink_line, kind, sink_file })] });

describe("change candidates", () => {
  const hunks = new Map<string, Array<[number, number]>>([["src/a.ts", [[100, 110]]]]);

  test("inDiff allows 8 lines either side", () => {
    expect([91, 92, 118, 119].map((l) => inDiff(c(l), hunks))).toEqual([false, true, true, false]);
    expect(inDiff(c(100, "idor", "src/b.ts"), hunks)).toBe(false);
  });

  test("in-diff first, then score; drops best scores under 2; keeps the first k", () => {
    const cs = [c(500), c(105), c(300, "xss"), c(108, "sqli"), c(95)];
    const scores = { "0": { votes: ["9"] }, "1": { votes: ["2", "1"] }, "2": { votes: ["8"] }, "3": { votes: ["1", "1"] }, "4": { votes: ["6"] } };
    const { kept, selected } = changeCandidates(cs, scores, hunks);
    // order: 4 (in diff, 6), 1 (in diff, 2), 3 (in diff, 1), 0 (9), 2 (8); 1 merges into 4 (same family, 10 lines)
    expect(kept.map((k) => [k.orig, k.inDiff])).toEqual([
      [4, true],
      [3, true],
      [0, false],
      [2, false],
    ]);
    expect(kept[0]!.merged.length).toBe(2);
    expect(selected).toEqual([0]);
    expect(changeCandidates(cs, scores, hunks, 0).selected).toEqual([]);
  });
});
