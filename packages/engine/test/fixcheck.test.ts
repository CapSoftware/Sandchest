import { describe, expect, test } from "bun:test";
import type { IndexerClient } from "../src/indexer";
import type { LlmClient } from "../src/llm";
import type { ChangedFile } from "../src/scan/changes";
import { checkFixes, foldPlaces, isDependencyManifest, placeChecks, renderChanges, sweptDependency } from "../src/scan/fixcheck";
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

describe("a finding that lists other places with the same flaw", () => {
  const step = (file: string, line: number, code: string) => ({ file, line, note: "no owner check", excerpt: ` ${line - 1}| // before\n ${line}| ${code}\n ${line + 1}| // after` });
  const base = {
    id: "f1",
    fingerprint: "aaaa",
    title: "Any user can read other customers' invoices",
    category: "broken_access_control",
    entryPoint: { file: "src/routes/invoices.ts", line: 10, description: "GET /invoices/:id" },
    attackPath: [step("src/routes/invoices.ts", 12, "return db.invoices.find(id);")],
  } as unknown as Finding & { id: string };
  const place = (file: string, line: number, title: string, text?: string) => ({ title, category: "broken_access_control" as const, at: `${file}:${line}`, entry: `${file}:${line - 2}`, variant: true, ...(text !== undefined && { text }) });
  const merged = {
    ...base,
    alsoReportedAs: [
      place("src/routes/credit-notes.ts", 21, "Any user can read other customers' credit notes", "return db.creditNotes.find(id);"),
      place("src/routes/receipts.ts", 17, "Any user can read other customers' receipts", "return db.receipts.find(id);"),
      // A repeat report of the finding's own code is not another place.
      { title: "Invoice read without a tenant filter", category: "broken_access_control" as const, at: "src/models/invoice.ts:5", entry: "src/routes/invoices.ts:10" },
    ],
  } as Finding & { id: string };

  test("is checked once per place, as the finding's own write-up pointed at that place", () => {
    expect(placeChecks(base)).toEqual([]);
    const checks = placeChecks(merged) as Array<Finding & { id: string }>;
    expect(checks.map((c) => c.id)).toEqual(["f1#place:0", "f1#place:1"]);
    expect(checks[0]).toMatchObject({ title: "Any user can read other customers' credit notes", fingerprint: "aaaa", entryPoint: { file: "src/routes/credit-notes.ts", line: 19 } });
    expect(checks[0]!.attackPath).toEqual([{ file: "src/routes/credit-notes.ts", line: 21, note: "The same flaw as “Any user can read other customers' invoices”, at this place.", excerpt: "21| return db.creditNotes.find(id);" }]);
    expect(checks[0]!.alsoReportedAs).toBeUndefined();
    // A place stored without its line's code, or with no location, cannot be found again.
    const bare = { ...base, alsoReportedAs: [place("src/routes/receipts.ts", 17, "Receipts"), { ...place("x", 1, "Bad", "code"), at: "nowhere" }] } as Finding & { id: string };
    expect(placeChecks(bare)).toEqual([{ id: "f1#place:0" }, { id: "f1#place:1" }]);
  });

  const result = (id: string, outcome: "fixed" | "open" | "stale", reason = `${outcome} reason`) => ({ id, outcome, reason });

  test("is fixed only when it is fixed at every place, and says where it is not", () => {
    expect(foldPlaces([merged], [result("f1", "fixed"), result("f1#place:0", "fixed"), result("f1#place:1", "fixed")])).toEqual([result("f1", "fixed")]);
    const partly = foldPlaces([merged], [result("f1", "fixed"), result("f1#place:0", "open", "No owner check yet."), result("f1#place:1", "fixed")]);
    expect(partly).toEqual([{ id: "f1", outcome: "open", reason: "Not fixed at every place it affects. src/routes/credit-notes.ts:21: No owner check yet." }]);
    // Fixed at the other places but not where the finding points.
    expect(foldPlaces([merged], [result("f1", "open", "Still no check."), result("f1#place:0", "fixed"), result("f1#place:1", "fixed")])[0]).toEqual({ id: "f1", outcome: "open", reason: "Not fixed at every place it affects. src/routes/invoices.ts:12: Still no check." });
    // A place whose code cannot be found is never taken for fixed.
    expect(foldPlaces([merged], [result("f1", "fixed"), result("f1#place:0", "stale"), result("f1#place:1", "fixed")])[0]).toMatchObject({ outcome: "open", reason: "Not fixed at every place it affects. src/routes/credit-notes.ts:21: could not be re-checked on the new code." });
    expect(foldPlaces([merged], [result("f1", "fixed"), result("f1#place:1", "fixed")])[0]!.outcome).toBe("open");
    expect(foldPlaces([merged], [result("f1", "stale"), result("f1#place:0", "fixed"), result("f1#place:1", "fixed")])[0]!.outcome).toBe("open");
    expect(foldPlaces([merged], [result("f1", "stale"), result("f1#place:0", "stale"), result("f1#place:1", "stale")])).toEqual([result("f1", "stale")]);
  });

  test("a finding with no other places keeps its own result exactly, in the findings' order", () => {
    const other = { ...base, id: "f2" } as Finding & { id: string };
    expect(foldPlaces([other, base], [result("f1", "open", "x"), result("f2", "fixed", "y")])).toEqual([result("f2", "fixed", "y"), result("f1", "open", "x")]);
    expect(foldPlaces([base], [])).toEqual([]);
  });

  test("when none of its code can be found any more, the whole finding is stale", async () => {
    const gone: IndexerClient = {
      async ready() {},
      async call<T>(tool: string): Promise<T> {
        if (tool === "read_file") throw Object.assign(new Error("no such file"), { kind: "bad_request" });
        throw new Error(`unexpected tool ${tool}`);
      },
    };
    const { results } = await checkFixes({ client: noLlm, indexer: gone, threatModel: {} as ThreatModel, findings: [merged, { ...base, id: "f2" } as Finding & { id: string }] });
    expect(results).toEqual([
      { id: "f1", outcome: "stale", reason: "The cited code no longer exists where it was or nearby." },
      { id: "f2", outcome: "stale", reason: "The cited code no longer exists where it was or nearby." },
    ]);
  });
});
