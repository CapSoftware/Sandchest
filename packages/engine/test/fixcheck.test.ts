import { describe, expect, test } from "bun:test";
import type { IndexerClient } from "../src/indexer";
import type { LlmClient } from "../src/llm";
import type { ChangedFile } from "../src/scan/changes";
import { checkFixes, isDependencyManifest, renderChanges, sweptDependency } from "../src/scan/fixcheck";
import type { OsvClient } from "../src/scan/osv";
import type { Finding, ThreatModel } from "../src/scan/schema";

const dependency = (title: string, sources = ["vulnerable_dependency"]) =>
  ({ id: "d1", title, category: "vulnerable_dependency", sources, entryPoint: { file: "src/a.ts", line: 1, description: "" }, attackPath: [{ file: "src/a.ts", line: 1, note: "", excerpt: "" }] }) as unknown as Finding & { id: string };

/** An indexer whose `deps` lists these packages; any other call fails the test. */
function indexer(deps: Array<{ name: string; version: string }>): IndexerClient {
  return {
    async ready() {},
    async call<T>(tool: string): Promise<T> {
      if (tool === "deps") return { dependencies: deps.map((d) => ({ ecosystem: "npm", manifest: "package-lock.json", direct: true, dev: false, reachability: "imported", ...d })) } as T;
      throw new Error(`unexpected tool ${tool}`);
    },
  };
}
const osv = (ids: string[]): OsvClient => ({ query: async (packages) => packages.map(() => ids.map((id) => ({ id, aliases: [], summary: "", severity: "critical" as const }))) });
const noLlm = {} as LlmClient;
const check = (finding: Finding & { id: string }, deps: Array<{ name: string; version: string }>, lookup?: OsvClient) =>
  checkFixes({ client: noLlm, indexer: indexer(deps), threatModel: {} as ThreatModel, findings: [finding], osv: lookup }).then((r) => r.results[0]!);

describe("dependency fix checks", () => {
  const finding = dependency("@scope/pkg@1.2.3 ships a known critical vulnerability (GHSA-aaaa-bbbb-cccc, GHSA-dddd-eeee-ffff)");

  test("reads the package, version and advisories from a sweep finding, and only a sweep finding", () => {
    expect(sweptDependency(finding)).toEqual({ name: "@scope/pkg", version: "1.2.3", advisories: ["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"] });
    expect(sweptDependency(dependency(finding.title, ["hunter"]))).toBeUndefined();
  });

  test("fixed when the package is gone, or the new version is clear of the named advisories", async () => {
    expect((await check(finding, [])).outcome).toBe("fixed");
    expect((await check(finding, [{ name: "@scope/pkg", version: "1.2.9" }], osv(["GHSA-other"]))).outcome).toBe("fixed");
  });

  test("open while the reported version is installed, the new one is still affected, or it cannot be checked", async () => {
    expect((await check(finding, [{ name: "@scope/pkg", version: "1.2.3" }], osv([]))).outcome).toBe("open");
    expect((await check(finding, [{ name: "@scope/pkg", version: "1.2.4" }], osv(["GHSA-dddd-eeee-ffff"]))).outcome).toBe("open");
    expect((await check(finding, [{ name: "@scope/pkg", version: "1.2.4" }])).outcome).toBe("open");
    const failing: OsvClient = { query: async () => Promise.reject(new Error("down")) };
    expect((await check(finding, [{ name: "@scope/pkg", version: "1.2.4" }], failing)).outcome).toBe("open");
  });

  test("recognises lockfiles and manifests across ecosystems", () => {
    expect(["package-lock.json", "web/pnpm-lock.yaml", "go.sum", "api/requirements-prod.txt", "Gemfile.lock", "app/App.csproj"].every(isDependencyManifest)).toBe(true);
    expect(["src/package.ts", "docs/requirements.md", "lib/gemfile.rb"].some(isDependencyManifest)).toBe(false);
  });
});

describe("the push's changes shown to the reviewer", () => {
  const finding = { entryPoint: { file: "routes.ts", line: 1, description: "" }, attackPath: [{ file: "auth.ts", line: 5, note: "", excerpt: "" }] } as unknown as Finding;
  const file = (path: string, patch?: string): ChangedFile => ({ path, status: "modified", additions: 1, deletions: 0, hunks: [], patch });

  test("cited files come first, and the total stays bounded", () => {
    const text = renderChanges(finding, [file("ui.ts", "@@ -1 +1 @@\n-a\n+b"), file("auth.ts", "@@ -5 +5,2 @@\n+if (!can(user)) throw forbidden();")]);
    expect(text.indexOf("auth.ts")).toBeLessThan(text.indexOf("ui.ts"));
    const many = Array.from({ length: 20 }, (_, i) => file(`f${i}.ts`, "x".repeat(5_000)));
    const capped = renderChanges(finding, many);
    expect(capped.length).toBeLessThan(20_000);
    expect(capped).toMatch(/more changed files not shown/);
  });
});
