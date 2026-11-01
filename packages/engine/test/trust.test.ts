import { describe, expect, test } from "bun:test";
import { trustTier, trustRank, type Finding, type Validation, type Category } from "../src/scan";

function finding(overrides: { category?: Category; validation?: Validation } = {}): Finding {
  return {
    fingerprint: "fp", title: "t", severity: "high", confidence: "medium", category: overrides.category ?? "broken_access_control",
    cwe: null, impact: "x", entryPoint: { file: "a.ts", line: 1, description: "e" },
    attackPath: [{ file: "a.ts", line: 1, note: "h", excerpt: "" }], attacker: "any_user", preconditions: "x",
    proofOfConcept: "x", fixGuidance: "x", guarantees: ["x"], mustNotBreak: [], regressionTest: "x", fixPrompt: "p", leads: [],
    skeptic: { confidence: "medium", reasoning: "r" }, validation: overrides.validation,
  };
}

describe("trustTier", () => {
  test("runtime verified → confirmed", () => {
    expect(trustTier(finding({ validation: { status: "verified", method: "two-tenant", detail: "" } }))).toBe("confirmed");
  });

  test("code-path proof → corroborated", () => {
    expect(trustTier(finding({ validation: { status: "path_confirmed", method: "code-path", detail: "" } }))).toBe("corroborated");
  });

  test("deterministic-sweep categories are corroborated by construction", () => {
    expect(trustTier(finding({ category: "vulnerable_dependency" }))).toBe("corroborated");
    expect(trustTier(finding({ category: "hardcoded_secret" }))).toBe("corroborated");
  });

  test("a lone judgment with no corroboration is unconfirmed", () => {
    expect(trustTier(finding())).toBe("unconfirmed");
    expect(trustTier(finding({ validation: { status: "inconclusive", method: "code-path", detail: "" } }))).toBe("unconfirmed");
  });

  test("verified outranks path_confirmed even for a deterministic category", () => {
    expect(trustTier(finding({ category: "vulnerable_dependency", validation: { status: "verified", method: "two-tenant", detail: "" } }))).toBe("confirmed");
  });
});

describe("trustRank", () => {
  test("orders confirmed < corroborated < unconfirmed, with undefined treated as unconfirmed", () => {
    expect(trustRank("confirmed")).toBeLessThan(trustRank("corroborated"));
    expect(trustRank("corroborated")).toBeLessThan(trustRank("unconfirmed"));
    expect(trustRank(undefined)).toBe(trustRank("unconfirmed"));
  });
});
