import { describe, expect, test } from "bun:test";
import type { Finding, ScanReport } from "@sandchest/engine/scan";
import type { Benchmark } from "../src/benchmark";
import { aggregate, score } from "../src/score";

const benchmark: Benchmark = {
  name: "demo",
  description: "",
  kind: "vulnerable",
  source: { path: "." },
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
    expect(result.shown).toEqual({ total: 4, truePositives: 2, falsePositives: 1, unjudged: 1 });
    expect(result.precision).toEqual({ lower: 0.5, known: 2 / 3 });
  });

  test("aggregate pools counts across benchmarks", () => {
    const a = score(benchmark, report([finding({ sink: ["a.ts", 10] })]));
    const clean = score({ ...benchmark, name: "clean", kind: "clean", expected: [] }, report([finding({ sink: ["q.ts", 1] })]));
    expect(aggregate([a, clean])).toEqual({ recall: 0.5, precision: { lower: 0.5, known: 1 }, unjudged: 1 });
  });
});
