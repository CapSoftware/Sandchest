import { describe, expect, test } from "bun:test";
import { dependencyFindings } from "../src/scan/leads";
import type { DependencyVulns } from "../src/scan/leads";
import type { Advisory } from "../src/scan/osv";
import { trustTier, type Finding } from "../src/scan";

function advisory(id: string, severity: Advisory["severity"], fixed?: string): Advisory {
  return { id, aliases: [], summary: `${id} summary`, severity, fixed };
}
function dep(name: string, advisories: Advisory[], over: Partial<DependencyVulns> = {}): DependencyVulns {
  return { ecosystem: "npm", name, version: "1.0.0", dev: false, reachability: "imported", importedAt: ["src/server.ts:3"], advisories, ...over };
}

describe("dependencyFindings", () => {
  test("emits a corroborated critical finding for a shipped imported dependency", () => {
    const [f, ...rest] = dependencyFindings([dep("next", [advisory("GHSA-1", "critical", "16.3.1")])], []);
    expect(rest).toHaveLength(0);
    expect(f!.category).toBe("vulnerable_dependency");
    expect(f!.severity).toBe("critical");
    expect(f!.title).toContain("next@1.0.0");
    expect(f!.fixGuidance).toContain("16.3.1");
    expect(f!.fixPrompt.length).toBeGreaterThan(0);
    expect(trustTier(f!)).toBe("corroborated");
  });

  test("critical only — high/medium/low advisories go to the leads hunter", () => {
    expect(dependencyFindings([dep("a", [advisory("x", "high")])], [])).toHaveLength(0);
    expect(dependencyFindings([dep("b", [advisory("y", "medium")])], [])).toHaveLength(0);
  });

  test("skips not-imported and dev/build/test dependencies", () => {
    expect(dependencyFindings([dep("a", [advisory("x", "critical")], { reachability: "not_imported" })], [])).toHaveLength(0);
    expect(dependencyFindings([dep("vitest", [advisory("x", "critical")], { dev: true })], [])).toHaveLength(0);
  });

  test("skips a dependency imported only from tooling, tests or config", () => {
    expect(dependencyFindings([dep("next-auth", [advisory("x", "critical")], { importedAt: [".agents/skills/scripts/db.mjs:1"] })], [])).toHaveLength(0);
    expect(dependencyFindings([dep("vite", [advisory("x", "critical")], { importedAt: ["apps/web/vite.config.ts:2"] })], [])).toHaveLength(0);
    // …but a product import site elsewhere keeps it, located at the product site.
    const [f] = dependencyFindings([dep("next", [advisory("x", "critical")], { importedAt: ["apps/web/next.config.mjs:1", "apps/web/app/layout.tsx:3"] })], []);
    expect(f!.entryPoint.file).toBe("apps/web/app/layout.tsx");
  });

  test("one finding per package, and none a hunter already reported", () => {
    // Three workspace copies of zod → a single finding.
    const zods = [dep("zod", [advisory("z", "critical")]), dep("zod", [advisory("z", "critical")], { version: "3.24.2" })];
    expect(dependencyFindings(zods, [])).toHaveLength(1);
    const already = [{ category: "vulnerable_dependency", title: "next@1.0.0 has 2 known vulnerabilities" } as Finding];
    expect(dependencyFindings([dep("next", [advisory("GHSA-1", "critical")])], already)).toHaveLength(0);
  });

  test("stable fingerprint across runs", () => {
    const a = dependencyFindings([dep("next", [advisory("GHSA-1", "critical")])], [])[0]!;
    const b = dependencyFindings([dep("next", [advisory("GHSA-1", "critical")])], [])[0]!;
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});
