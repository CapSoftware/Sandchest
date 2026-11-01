import { describe, expect, test } from "bun:test";
import { mergeReports } from "../src/scan/ensemble";
import type { Finding, Severity, TrustTier, Validation } from "../src/scan";

function f(fingerprint: string, over: Partial<Finding> = {}): Finding {
  return {
    fingerprint, title: `finding ${fingerprint}`, severity: "medium", confidence: "medium", category: "broken_access_control",
    cwe: null, impact: "x", entryPoint: { file: "a.ts", line: 1, description: "e" },
    attackPath: [{ file: "a.ts", line: 1, note: "h", excerpt: "" }], attacker: "any_user", preconditions: "x",
    proofOfConcept: "x", fixGuidance: "x", guarantees: ["x"], mustNotBreak: [], regressionTest: "x", fixPrompt: "p",
    leads: [], skeptic: { confidence: "medium", reasoning: "r" }, ...over,
  };
}
const rep = (...findings: Finding[]) => ({ findings });

describe("mergeReports", () => {
  test("unions by fingerprint and counts support across runs", () => {
    const m = mergeReports([rep(f("A"), f("B")), rep(f("A"), f("C")), rep(f("A"))]);
    expect(m.runs).toBe(3);
    const support = Object.fromEntries(m.findings.map((x) => [x.fingerprint, x.support.found]));
    expect(support).toEqual({ A: 3, B: 1, C: 1 });
    expect(m.findings.every((x) => x.support.of === 3)).toBe(true);
    expect(m.unanimous).toBe(1); // A, in all 3
    expect(m.singletons).toBe(2); // B and C
  });

  test("a fingerprint seen twice in one run still counts once for that run", () => {
    const m = mergeReports([rep(f("A"), f("A")), rep(f("A"))]);
    expect(m.findings.find((x) => x.fingerprint === "A")!.support.found).toBe(2);
  });

  test("keeps the strongest instance: higher trust, then severity, then validated", () => {
    const weak = f("A", { trust: "unconfirmed", severity: "low" as Severity });
    const strong = f("A", { trust: "corroborated" as TrustTier, severity: "high" as Severity, validation: { status: "path_confirmed", method: "code-path", detail: "" } as Validation });
    const merged = mergeReports([rep(weak), rep(strong)]).findings[0]!;
    expect(merged.trust).toBe("corroborated");
    expect(merged.severity).toBe("high");
    expect(merged.support.found).toBe(2);
  });

  test("orders by severity, then support, then trust", () => {
    const m = mergeReports([
      rep(f("crit", { severity: "critical" }), f("hi2", { severity: "high" }), f("hi1", { severity: "high" })),
      rep(f("hi1", { severity: "high" })), // hi1 gets support 2, hi2 support 1
    ]);
    expect(m.findings.map((x) => x.fingerprint)).toEqual(["crit", "hi1", "hi2"]);
  });
});
