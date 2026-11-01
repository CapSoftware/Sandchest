import { describe, expect, test } from "bun:test";
import { dependencyFindings } from "../src/scan/leads";
import type { DependencyVulns } from "../src/scan/leads";
import type { Advisory } from "../src/scan/osv";
import { trustTier, type Finding } from "../src/scan";

function advisory(id: string, severity: Advisory["severity"], fixed?: string): Advisory {
  return { id, aliases: [], summary: `${id} summary`, severity, fixed };
}
function dep(name: string, reachability: DependencyVulns["reachability"], advisories: Advisory[], importedAt = ["src/server.ts:3"]): DependencyVulns {
  return { ecosystem: "npm", name, version: "1.0.0", reachability, importedAt, advisories };
}

describe("dependencyFindings", () => {
  test("emits a corroborated finding for an imported critical advisory", () => {
    const [f, ...rest] = dependencyFindings([dep("next", "imported", [advisory("GHSA-1", "critical", "16.3.1")])], []);
    expect(rest).toHaveLength(0);
    expect(f!.category).toBe("vulnerable_dependency");
    expect(f!.severity).toBe("critical");
    expect(f!.title).toContain("next@1.0.0");
    expect(f!.fixGuidance).toContain("16.3.1");
    expect(f!.fixPrompt.length).toBeGreaterThan(0);
    expect(trustTier(f!)).toBe("corroborated"); // deterministic origin
  });

  test("skips not-imported and medium/low advisories", () => {
    expect(dependencyFindings([dep("a", "not_imported", [advisory("x", "critical")])], [])).toHaveLength(0);
    expect(dependencyFindings([dep("b", "imported", [advisory("y", "medium")])], [])).toHaveLength(0);
  });

  test("worst advisory decides severity; high → medium confidence", () => {
    const [f] = dependencyFindings([dep("c", "imported", [advisory("lo", "low"), advisory("hi", "high")])], []);
    expect(f!.severity).toBe("high");
    expect(f!.confidence).toBe("medium");
  });

  test("does not duplicate a package a hunter already reported", () => {
    const already = [{ category: "vulnerable_dependency", title: "next@1.0.0 has 2 known vulnerabilities" } as Finding];
    expect(dependencyFindings([dep("next", "imported", [advisory("GHSA-1", "critical")])], already)).toHaveLength(0);
  });

  test("stable fingerprint across runs for the same package+advisory", () => {
    const a = dependencyFindings([dep("next", "imported", [advisory("GHSA-1", "critical")])], [])[0]!;
    const b = dependencyFindings([dep("next", "imported", [advisory("GHSA-1", "critical")])], [])[0]!;
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});
