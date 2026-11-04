import { describe, expect, test } from "bun:test";
import type { Finding, ScanReport } from "@sandchest/engine/scan";
import type { Benchmark } from "../src/benchmark";
import { aggregate, score, scorePatched, stability } from "../src/score";

const benchmark: Benchmark = {
  name: "demo",
  description: "",
  kind: "vulnerable",
  source: { path: "." },
  advisories: [],
  tags: ["core"],
  expected: [
    { id: "sqli", title: "", severity: "critical", category: "sql_injection", cwe: ["CWE-89"], locations: [{ file: "a.ts", startLine: 10, endLine: 12 }] },
    { id: "idor", title: "", severity: "high", category: "broken_access_control", cwe: ["CWE-639"], locations: [{ file: "b.ts", startLine: 5, endLine: 5 }] },
    { id: "key", title: "", severity: "medium", category: "hardcoded_secret", cwe: ["CWE-798"], locations: [{ file: "c.ts", startLine: 3, endLine: 3 }] },
  ],
  decoys: [{ file: "safe.ts", startLine: 1, endLine: 10, note: "" }],
};

function finding(overrides: Partial<Finding> & { sink: [string, number] }): Finding {
  const { sink, ...rest } = overrides;
  return {
    fingerprint: `${sink[0]}:${sink[1]}`,
    title: "t",
    severity: "high",
    confidence: "high",
    category: "sql_injection",
    cwe: null,
    impact: "",
    mitigations: "",
    entryPoint: { file: "routes.ts", line: 1, description: "" },
    attackPath: [{ file: sink[0], line: sink[1], note: "", excerpt: "" }],
    attacker: "unauthenticated",
    preconditions: "",
    proofOfConcept: "",
    fixGuidance: "",
    guarantees: [],
    mustNotBreak: [],
    regressionTest: "",
    fixPrompt: "",
    leads: [],
    skeptic: { confidence: "high", reasoning: "" },
    ...rest,
  };
}

function report(findings: Finding[], leads: ScanReport["leads"] = []): ScanReport {
  return { findings, leads } as ScanReport;
}

describe("score", () => {
  test("matches by location within tolerance and by class or CWE", () => {
    const result = score(
      benchmark,
      report([
        finding({ sink: ["a.ts", 16] }),
        finding({ sink: ["b.ts", 5], category: "other", cwe: "CWE-639" }),
        finding({ sink: ["a.ts", 11], category: "xss" }),
      ]),
    );
    expect(result.findings.map((f) => f.matches)).toEqual([["sqli"], ["idor"], []]);
    expect(result.recall).toBe(1);
  });

  test("credits secret leads for hardcoded secrets", () => {
    const result = score(benchmark, report([], [{ id: "L1", kind: "secret", title: "", at: "c.ts:3", detail: "" }]));
    expect(result.missed.map((m) => m.id)).toEqual(["sqli", "idor"]);
    expect(result.recallAll).toBeCloseTo(1 / 3);
  });

  test("precision counts decoys and judgements, and reports unjudged findings", () => {
    const result = score(
      benchmark,
      report([
        finding({ sink: ["a.ts", 10] }),
        finding({ sink: ["safe.ts", 4] }),
        finding({ sink: ["x.ts", 1] }),
        finding({ sink: ["y.ts", 1] }),
        finding({ sink: ["z.ts", 1], confidence: "low" }),
        finding({ sink: ["w.ts", 1], severity: "medium" }),
      ]),
      { "x.ts:1": "real" },
    );
    expect(result.shown).toEqual({ total: 4, truePositives: 2, falsePositives: 1, duplicates: 0, unjudged: 1, testCode: 0 });
    expect(result.precision).toEqual({ lower: 0.5, known: 2 / 3 });
  });

  test("aggregate pools counts across benchmarks", () => {
    const a = score(benchmark, report([finding({ sink: ["a.ts", 10] })]));
    const clean = score({ ...benchmark, name: "clean", kind: "clean", expected: [] }, report([finding({ sink: ["q.ts", 1] })]));
    const total = aggregate([a, clean]);
    expect(total.recall).toBe(0.5);
    expect(total.precision).toEqual({ lower: 0.5, known: 1 });
    expect(total.unjudged).toBe(1);
  });

  test("a second finding of the same expected bug is a duplicate, not a true positive", () => {
    const result = score(benchmark, report([finding({ sink: ["a.ts", 10] }), finding({ sink: ["a.ts", 12], category: "sql_injection" }), finding({ sink: ["b.ts", 5], category: "broken_access_control" }), finding({ sink: ["routes.ts", 1], category: "broken_access_control", attackPath: [{ file: "routes.ts", line: 2, note: "", excerpt: "" }] })]));
    expect(result.findings.map((f) => f.outcome)).toEqual(["true_positive", "duplicate", "true_positive", "unjudged"]);
    expect(result.shown.duplicates).toBe(1);
    // Duplicates stay out of precision: 2 true positives, 1 unjudged.
    expect(result.precision.lower).toBeCloseTo(2 / 3);
    expect(aggregate([result]).duplicateRate).toBeCloseTo(1 / 4);
  });

  test("one hop through another bug's location is not a match; the sink or two cited lines are", () => {
    const hub = (path: Array<[string, number]>) => finding({ sink: path.at(-1)!, attackPath: path.map(([file, line]) => ({ file, line, note: "", excerpt: "" })) });
    const result = score(benchmark, report([hub([["a.ts", 11], ["z.ts", 1]]), hub([["a.ts", 10], ["a.ts", 12], ["z.ts", 2]]), hub([["q.ts", 1], ["a.ts", 12]])]));
    expect(result.findings.map((f) => f.matches)).toEqual([[], ["sqli"], ["sqli"]]);
  });

  test("judgement records: verdicts, duplicates and not-security count as intended", () => {
    const result = score(
      benchmark,
      report([finding({ sink: ["x.ts", 1] }), finding({ sink: ["y.ts", 1] }), finding({ sink: ["z.ts", 1] })]),
      { "x.ts:1": { verdict: "real" }, "y.ts:1": { verdict: "duplicate", duplicateOf: "x.ts:1" }, "z.ts:1": { verdict: "not_security" } },
    );
    expect(result.findings.map((f) => [f.outcome, f.reason])).toEqual([["true_positive", undefined], ["duplicate", "judged"], ["false_positive", "not_security"]]);
    expect(result.precision).toEqual({ lower: 0.5, known: 0.5 });
  });

  test("a finding in two bugs' ranges is credited to one, so the other's own finding is not a duplicate", () => {
    const near: Benchmark = {
      ...benchmark,
      expected: [
        { id: "a", title: "", severity: "high", category: "broken_authentication", cwe: [], locations: [{ file: "jwt.ts", startLine: 10, endLine: 30 }] },
        { id: "b", title: "", severity: "high", category: "broken_authentication", cwe: [], locations: [{ file: "jwt.ts", startLine: 25, endLine: 40 }] },
      ],
    };
    // The first sits where both ranges overlap; the second only in a's.
    const result = score(near, report([finding({ sink: ["jwt.ts", 27], category: "broken_authentication" }), finding({ sink: ["jwt.ts", 12], category: "broken_authentication" })]));
    expect(result.findings.map((f) => f.outcome)).toEqual(["true_positive", "true_positive"]);
    // A third report of a is a duplicate.
    const three = score(near, report([finding({ sink: ["jwt.ts", 27], category: "broken_authentication" }), finding({ sink: ["jwt.ts", 12], category: "broken_authentication" }), finding({ sink: ["jwt.ts", 14], category: "broken_authentication" })]));
    expect(three.findings.map((f) => f.outcome)).toEqual(["true_positive", "true_positive", "duplicate"]);
  });

  test("a duplicate counts as the bug it duplicates when that is not otherwise in the scan", () => {
    const judgements = {
      "q.ts:1": { verdict: "duplicate" as const, duplicateOf: "expected:sqli" },
      "y.ts:1": { verdict: "duplicate" as const, duplicateOf: "x.ts:1" },
      "x.ts:1": { verdict: "real" as const },
    };
    // The reviewer's match stands in for the missed line range, and the canonical's verdict for a missing canonical.
    const alone = score(benchmark, report([finding({ sink: ["q.ts", 1] }), finding({ sink: ["y.ts", 1] })]), judgements);
    expect(alone.findings.map((f) => [f.outcome, f.matches])).toEqual([["true_positive", ["sqli"]], ["true_positive", []]]);
    expect(alone.recall).toBe(0.5);
    // Alongside the bug it repeats, it is a duplicate.
    const both = score(benchmark, report([finding({ sink: ["a.ts", 10] }), finding({ sink: ["q.ts", 1] })]), judgements);
    expect(both.findings.map((f) => f.outcome)).toEqual(["true_positive", "duplicate"]);
  });

  test("a judgement carries over to the same bug under a new fingerprint", () => {
    const judgements = { old: { verdict: "false_positive" as const, where: { category: "sql_injection", entry: "routes.ts:1", path: ["q.ts:40"] } } };
    const result = score(benchmark, report([finding({ sink: ["q.ts", 42] }), finding({ sink: ["q.ts", 90] })]), judgements);
    expect(result.findings.map((f) => f.outcome)).toEqual(["false_positive", "false_positive"]);
    const elsewhere = score(benchmark, report([{ ...finding({ sink: ["q.ts", 90] }), entryPoint: { file: "other.ts", line: 3, description: "" } }]), judgements);
    expect(elsewhere.findings[0]!.outcome).toBe("unjudged");
  });

  test("a judged finding still in the scan lends its verdict to no other finding at its lines", () => {
    const judged = finding({ sink: ["q.ts", 40] });
    const judgements = { [judged.fingerprint]: { verdict: "false_positive" as const, where: { category: "sql_injection", entry: "routes.ts:1", path: ["q.ts:40"] } } };
    const result = score(benchmark, report([judged, finding({ sink: ["q.ts", 42] })]), judgements);
    expect(result.findings.map((f) => f.outcome)).toEqual(["false_positive", "unjudged"]);
  });

  test("flags findings whose whole path is test code, and severity against expected", () => {
    const result = score(
      benchmark,
      report([finding({ sink: ["a.ts", 10], severity: "high" }), finding({ sink: ["test/fixtures/app.ts", 3], entryPoint: { file: "src/app.spec.ts", line: 1, description: "" } })]),
    );
    expect(result.findings.map((f) => f.testCode)).toEqual([false, true]);
    expect(result.shown.testCode).toBe(1);
    expect(result.severity).toEqual({ exact: 0, under: 1, over: 0 });
  });

  test("a fixed bug still reported at its patched location is a false positive on fixed code", () => {
    const patched: Benchmark = {
      ...benchmark,
      expected: [
        { ...benchmark.expected[0]!, patchedLocations: [{ file: "a.ts", startLine: 20, endLine: 22 }] },
        { ...benchmark.expected[1]!, patchedLocations: [{ file: "b.ts", startLine: 5, endLine: 5 }], partialFix: true },
      ],
    };
    const result = scorePatched(patched, report([finding({ sink: ["a.ts", 21] }), finding({ sink: ["b.ts", 5], category: "broken_access_control" })]));
    expect(result).toEqual({ name: "demo", checked: 1, reflagged: ["sqli"], findings: 2 });
  });

  test("stability: union recall, agreement and fingerprint identity across runs", () => {
    const one = score(benchmark, report([finding({ sink: ["a.ts", 10] }), finding({ sink: ["b.ts", 5], category: "broken_access_control" })]));
    const two = score(benchmark, report([{ ...finding({ sink: ["a.ts", 11] }), fingerprint: "other" }]));
    const s = stability(benchmark, [one, two]);
    expect(s.recalls).toEqual([1, 0.5]);
    expect(s.unionRecall).toBe(1);
    expect(s.agreement).toBe(0.5);
    // sqli found in both runs, under different fingerprints.
    expect(s.fingerprintStability).toBe(0);
  });
});
