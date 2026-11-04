import { describe, expect, test } from "bun:test";
import { consolidateFindings, sameBug, type Finding } from "../src/scan";
import { mockEndpoint, sse, textReply } from "./helpers";

const endpoint = mockEndpoint();

function finding(fingerprint: string, overrides: Partial<Finding> = {}): Finding {
  return {
    fingerprint,
    title: `finding ${fingerprint}`,
    severity: "high",
    confidence: "medium",
    category: "broken_authentication",
    cwe: null,
    impact: "",
    mitigations: "",
    entryPoint: { file: `routes/${fingerprint}.ts`, line: 1, description: "" },
    attackPath: [{ file: `lib/${fingerprint}.ts`, line: 10, note: "", excerpt: "" }],
    attacker: "unauthenticated",
    preconditions: "",
    proofOfConcept: "",
    fixGuidance: `fix ${fingerprint}`,
    guarantees: [],
    mustNotBreak: [],
    regressionTest: "",
    fixPrompt: "",
    leads: [fingerprint],
    skeptic: { confidence: "medium", reasoning: "" },
    ...overrides,
  };
}

const reply = (groups: unknown[]) => () => sse(textReply(JSON.stringify({ groups })));

describe("consolidateFindings", () => {
  test("merges a one-fix group into the chosen finding, keeping the worst severity and noting what it absorbed", async () => {
    const findings = [finding("a"), finding("b", { severity: "critical", confidence: "high" }), finding("c"), finding("d", { category: "vulnerable_dependency", fixGuidance: "Upgrade lib." })];
    endpoint.respond(reply([{ why: "same verify call", fixAt: "lib/a.ts:10", oneFix: true, findings: ["F1", "F2", "F4"], keep: "F1" }]));
    const result = await consolidateFindings({ client: endpoint.client(), findings });

    expect(result.findings.map((f) => f.fingerprint)).toEqual(["a", "c"]);
    const merged = result.findings[0]!;
    expect(merged).toMatchObject({ severity: "critical", confidence: "high", fixGuidance: "fix a Upgrade lib.", leads: ["a", "b", "d"] });
    expect(merged.alsoReportedAs).toEqual([
      { title: "finding b", category: "broken_authentication", at: "lib/b.ts:10", entry: "routes/b.ts:1" },
      { title: "finding d", category: "vulnerable_dependency", at: "lib/d.ts:10", entry: "routes/d.ts:1" },
    ]);
    expect(result.merged.map((m) => [m.into, m.finding.fingerprint])).toEqual([["a", "b"], ["a", "d"]]);
  });

  test("ignores groups the model says need more than one fix, unknown ids and repeated ids", async () => {
    const findings = [finding("a"), finding("b"), finding("c")];
    endpoint.respond(
      reply([
        { why: "separate handlers", fixAt: "x:1", oneFix: false, findings: ["F1", "F2"], keep: "F1" },
        { why: "same", fixAt: "x:1", oneFix: true, findings: ["F3", "F9"], keep: "F9" },
      ]),
    );
    expect((await consolidateFindings({ client: endpoint.client(), findings })).findings).toHaveLength(3);
  });

  test("returns findings unchanged when the review fails", async () => {
    const findings = [finding("a"), finding("b")];
    endpoint.respond(
      () => new Response("bad", { status: 400 }),
      () => new Response("bad", { status: 400 }),
      () => new Response("bad", { status: 400 }),
    );
    const result = await consolidateFindings({ client: endpoint.client(), findings });
    expect(result).toMatchObject({ findings, merged: [] });
  });

  test("a merged finding is recognised on rescan by any report it absorbed", async () => {
    endpoint.respond(reply([{ why: "same", fixAt: "lib/a.ts:10", oneFix: true, findings: ["F1", "F2"], keep: "F1" }]));
    const [merged] = (await consolidateFindings({ client: endpoint.client(), findings: [finding("a"), finding("b")] })).findings;
    const stored = { fingerprint: "old", category: "broken_authentication", entryPoint: { file: "elsewhere.ts", line: 5 }, attackPath: [{ file: "lib/b.ts", line: 11 }] };
    expect(sameBug(merged!, stored)).toBe(true);
  });
});
