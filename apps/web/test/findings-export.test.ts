/**
 * Copying the findings list out: the agent prompt, the CLI commands, the
 * Markdown report and the JSON, from rows as the export query returns them.
 */
import { describe, expect, test } from "bun:test";
import type { ExportedFinding } from "@sandchest/db";
import { agentPrompt, exportFindings, type ExportContext } from "@/lib/findings-export";

function row(id: string, change: Partial<ExportedFinding> = {}): ExportedFinding {
  return {
    id,
    repoFullName: "acme/api",
    provider: "github",
    defaultBranch: "main",
    title: `Finding ${id}`,
    severity: "critical",
    confidence: "high",
    category: "broken_access_control",
    cwe: "CWE-639",
    status: "open",
    dismissReason: null,
    impact: "Reads other customers' invoices.",
    mitigations: "",
    entryPoint: { file: "routes/invoices.ts", line: 4, description: "GET /invoices/:id" },
    attackPath: [
      { file: "routes/invoices.ts", line: 4, note: "takes the id from the path", excerpt: "4| const id = req.params.id" },
      { file: "db/invoices.ts", line: 12, note: "loads it without an owner check", excerpt: "12| return db.find(id)" },
    ],
    attacker: "any_user",
    preconditions: "Any signed-in user.",
    proofOfConcept: "curl /invoices/2",
    fixGuidance: "Scope the query to the caller's org.",
    guarantees: ["Only the owner's org can read an invoice"],
    mustNotBreak: ["Owners still read their own invoices"],
    regressionTest: "Request another org's invoice and expect 404.",
    prNumber: null,
    firstSeenAt: new Date("2026-11-01T10:00:00Z"),
    lastSeenAt: new Date("2026-11-02T10:00:00Z"),
    fixedAt: null,
    stale: false,
    ...change,
  };
}

const context: ExportContext = {
  baseUrl: "https://sandchest.test",
  filters: { status: "open", severities: [], includeLowConfidence: false },
  now: new Date("2026-11-03T12:00:00Z"),
};

describe("agent prompt", () => {
  test("carries everything the single-finding prompt does, code excerpts included", () => {
    const prompt = agentPrompt([row("a"), row("b", { severity: "high", title: "Second | one" })]);
    expect(prompt).toStartWith("Fix these 2 security vulnerabilities, most severe first.");
    expect(prompt).toContain("They are all in acme/api.");
    expect(prompt).toContain("1. Critical: Finding a (db/invoices.ts:12)\n2. High: Second | one (db/invoices.ts:12)");
    expect(prompt).toContain("# 2. Second | one\nHigh severity · high confidence · CWE-639\n\nCited lines are as of the last scan that saw it, on 2 Nov 2026.");
    expect(prompt).toContain("It is reached through GET /invoices/:id (`routes/invoices.ts:4`) and lands at `db/invoices.ts:12`.");
    expect(prompt).toContain("2. `db/invoices.ts:12` — loads it without an owner check\n\n```\n12| return db.find(id)\n```");
    for (const section of ["## Proof of concept", "## How to fix it", "## The fix must guarantee", "## It must not break", "## Regression test"]) expect(prompt).toContain(section);
  });

  test("tells the agent to confirm before changing code, keep fixes apart, and report on each", () => {
    const prompt = agentPrompt([row("a"), row("b")]);
    expect(prompt).toContain("Confirm each one against the current code before changing anything");
    expect(prompt).toContain("If it passes, or the path no longer holds");
    expect(prompt).toContain("Keep each fix self-contained");
    expect(prompt).toContain("Never weaken, skip or delete existing tests");
    expect(prompt).toContain("report on every finding by number");
  });

  test("flags moved code and findings from unmerged pull requests", () => {
    const prompt = agentPrompt([row("a", { stale: true, prNumber: 12 })]);
    expect(prompt).toContain("Found reviewing pull request #12: if that pull request hasn't merged, this code is on its branch.");
    expect(prompt).toContain("The cited code has changed since that scan.");
  });

  test("across repositories, tells the agent to fix only its own", () => {
    const prompt = agentPrompt([row("a"), row("b", { repoFullName: "acme/web" })]);
    expect(prompt).toContain("They span 2 repositories (acme/api, acme/web). Fix only the ones in the repository you are working in");
    expect(prompt).toContain("(db/invoices.ts:12, acme/web)");
    expect(prompt).toContain("Critical severity · high confidence · CWE-639 · acme/web");
  });

  test("a single finding reads as one", () => {
    const prompt = agentPrompt([row("a")]);
    expect(prompt).toStartWith("Fix this security vulnerability.\n\nIt is in acme/api.");
    expect(prompt).toContain("Confirm it against the current code");
    expect(prompt).not.toContain("one at a time");
    expect(prompt).not.toContain("1. Critical: Finding a");
  });

  test("commands pass the prompt through a quoted heredoc", () => {
    const command = exportFindings([row("a")], "claude", context);
    expect(command).toStartWith(`claude "$(cat <<'SANDCHEST'\nFix this security vulnerability.`);
    expect(command).toEndWith(`and expect 404.\nSANDCHEST\n)"`);
    expect(exportFindings([row("a")], "codex", context)).toStartWith("codex ");
  });
});

describe("markdown report", () => {
  test("summarises the filters, tabulates the findings and links back to each", () => {
    const report = exportFindings([row("a", { title: "Pipe | title" }), row("b", { status: "dismissed", dismissReason: "false_positive", stale: true })], "markdown", {
      ...context,
      filters: { status: "open", severities: ["critical", "high"], repo: "repo-id", includeLowConfidence: true },
    });
    expect(report).toStartWith("# Sandchest findings\n\n2 open findings · Critical, High · acme/api · low confidence included. Exported 3 Nov 2026.");
    expect(report).toContain("| 1 | Critical | [Pipe \\| title](https://sandchest.test/dashboard/findings/a) | acme/api | `db/invoices.ts:12` |");
    expect(report).toContain("**Critical** · high confidence");
    expect(report).toContain("Dismissed: false positive");
    expect(report).toContain("The cited code has changed since it was found");
    expect(report).toContain("[`db/invoices.ts:12`](https://github.com/acme/api/blob/main/db/invoices.ts#L12)");
    expect(report).toContain("### Proof of concept");
    expect(report).not.toContain("db.find(id)");
  });

  test("links a Forgejo repository's code to its Forgejo instance", () => {
    const report = exportFindings([row("a", { provider: "forgejo" }), row("b")], "markdown", { ...context, forgejoUrl: "https://git.example.com" });
    expect(report).toContain("[`db/invoices.ts:12`](https://git.example.com/acme/api/src/branch/main/db/invoices.ts#L12)");
    expect(report).toContain("[`db/invoices.ts:12`](https://github.com/acme/api/blob/main/db/invoices.ts#L12)");
  });
});

describe("json", () => {
  test("carries the filters and each finding without excerpts", () => {
    const data = JSON.parse(exportFindings([row("a")], "json", context));
    expect(data.filters).toEqual({ status: "open", severities: [], repository: null, includeLowConfidence: false });
    expect(data.findings[0]).toMatchObject({ id: "a", url: "https://sandchest.test/dashboard/findings/a", repository: "acme/api", cwe: "CWE-639", mitigations: null, firstSeenAt: "2026-11-01T10:00:00.000Z" });
    expect(data.findings[0].attackPath[1]).toEqual({ file: "db/invoices.ts", line: 12, note: "loads it without an owner check" });
  });
});
