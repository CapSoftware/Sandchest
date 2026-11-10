/**
 * The findings list, copied out: as one prompt for a coding agent (or a
 * command that hands it to one), as a Markdown report, or as JSON.
 *
 * Only the agent formats carry code excerpts: they anchor the agent to the
 * right code even when lines have moved. A report pasted into an issue or a
 * chat, or JSON piped into other tools, should not carry source code.
 */
import { findingPlaces, type ExportedFinding } from "@sandchest/db";
import { findingSections, type PromptFinding } from "@sandchest/engine/fix-prompt";
import { agentCommand } from "./agent-links";
import { categoryLabel, DISMISS_REASON_LABEL, githubLine, plural, SEVERITY_LABEL, shortDate, type Severity } from "./format";

export const EXPORT_FORMATS = ["prompt", "claude", "codex", "markdown", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportContext {
  /** The dashboard's address, for links back to each finding. */
  baseUrl: string;
  /** What the list was filtered by, as shown on the page. */
  filters: { status: string; severities: Severity[]; repo?: string; includeLowConfidence: boolean };
  now?: Date;
}

export function exportFindings(rows: ExportedFinding[], format: ExportFormat, context: ExportContext): string {
  switch (format) {
    case "prompt":
      return agentPrompt(rows);
    case "claude":
    case "codex":
      return agentCommand(format, agentPrompt(rows));
    case "markdown":
      return markdownReport(rows, context);
    case "json":
      return jsonExport(rows, context);
  }
}

/**
 * One prompt that has an agent fix every finding, most severe first, with
 * everything the single-finding prompt carries (code excerpts included) and
 * a way of working that holds up across many: confirm each finding before
 * touching code, fix it on its own, and report what happened to each.
 */
export function agentPrompt(rows: ExportedFinding[]): string {
  const one = rows.length === 1;
  const repos = [...new Set(rows.map((row) => row.repoFullName))];
  const many = repos.length > 1;
  const where = many
    ? `They span ${repos.length} repositories (${repos.join(", ")}). Fix only the ones in the repository you are working in, and leave the rest out of your report.`
    : `${one ? "It is" : "They are all"} in ${repos[0]}.`;
  const index = rows.map((row, i) => `${i + 1}. ${SEVERITY_LABEL[row.severity]}: ${row.title} (${sinkOf(row)}${many ? `, ${row.repoFullName}` : ""})`).join("\n");
  const body = rows
    .map((row, i) => {
      const facts = [`${SEVERITY_LABEL[row.severity]} severity`, `${row.confidence} confidence`, row.cwe, many ? row.repoFullName : ""].filter(Boolean).join(" · ");
      const notes = [
        `Cited lines are as of the last scan that saw it, on ${shortDate(row.lastSeenAt)}.`,
        row.prNumber !== null ? `Found reviewing pull request #${row.prNumber}: if that pull request hasn't merged, this code is on its branch.` : "",
        row.stale ? "The cited code has changed since that scan. Find it by the excerpts and notes below, not the line numbers, and check the path still holds." : "",
      ].filter(Boolean);
      return `# ${i + 1}. ${row.title}\n${facts}\n\n${notes.join("\n")}\n\n${findingSections(promptFinding(row, { excerpts: true }))}`;
    })
    .join("\n\n---\n\n");
  const them = one ? "it" : "each one";

  return `Fix ${one ? "this security vulnerability" : `these ${rows.length} security vulnerabilities, most severe first`}.

${where}

## How to work
${one ? "" : "- Take them one at a time, in the order listed.\n"}- Confirm ${them} against the current code before changing anything: follow the attack path from the entry point to where it lands. The code excerpts show what was there when it was found; if the code has moved, find it by them.
- Write the regression test first and confirm it fails against the current code. If it passes, or the path no longer holds (already fixed, unreachable, or the code is gone), change nothing for it and say why in your report.
- Make the smallest change that closes the attack path and meets every point under "The fix must guarantee", without breaking anything under "It must not break". Then run the regression test and the existing suite.
${one ? "" : "- Keep each fix self-contained, so it can be reviewed and reverted on its own. Where several share a root cause, one fix may close them all; still give each its own regression test.\n"}- Never weaken, skip or delete existing tests or checks to make anything pass.

When you're done, report ${one ? "whether it is fixed: the change and the test that proves it, or why not" : "on every finding by number: fixed (the change and the test that proves it), or not fixed and why"}.
${one ? "" : `\n${index}\n`}
---

${body}`;
}

/** A report for an issue, a doc or a chat: a summary table, then each finding in full. */
export function markdownReport(rows: ExportedFinding[], context: ExportContext): string {
  const link = (row: ExportedFinding) => `${context.baseUrl}/dashboard/findings/${row.id}`;
  const table = rows.map((row, i) => `| ${i + 1} | ${SEVERITY_LABEL[row.severity]} | [${cell(row.title)}](${link(row)}) | ${cell(row.repoFullName)} | \`${cell(sinkOf(row))}\` |`).join("\n");
  const body = rows
    .map((row, i) => {
      const rating = [`**${SEVERITY_LABEL[row.severity]}**`, `${row.confidence} confidence`, categoryLabel(row.category), row.cwe, statusOf(row)].filter(Boolean).join(" · ");
      const origin = [`Repository: ${row.repoFullName}`, row.prNumber !== null ? `found reviewing PR #${row.prNumber}` : "", `first seen ${shortDate(row.firstSeenAt)}`, `[view in Sandchest](${link(row)})`].filter(Boolean).join(" · ");
      const moved = row.stale ? "\n\nThe cited code has changed since it was found; the next deep scan checks it again." : "";
      const sections = findingSections(promptFinding(row), { heading: "###", link: (file, line) => githubLine(row.repoFullName, row.defaultBranch, file, line) });
      return `## ${i + 1}. ${row.title}\n\n${rating}\n\n${origin}${moved}\n\n${sections}`;
    })
    .join("\n\n---\n\n");

  return `# Sandchest findings

${describe(rows, context)}. Exported ${shortDate(context.now ?? new Date())}.

| # | Severity | Finding | Repository | Where it lands |
| --- | --- | --- | --- | --- |
${table}

${body}
`;
}

/** The findings as data, for scripts and tools. */
export function jsonExport(rows: ExportedFinding[], context: ExportContext): string {
  const filters = context.filters;
  return JSON.stringify(
    {
      exportedAt: (context.now ?? new Date()).toISOString(),
      filters: { status: filters.status, severities: filters.severities, repository: filters.repo ?? null, includeLowConfidence: filters.includeLowConfidence },
      findings: rows.map((row) => {
        const finding = promptFinding(row);
        return {
          id: row.id,
          url: `${context.baseUrl}/dashboard/findings/${row.id}`,
          repository: row.repoFullName,
          title: row.title,
          severity: row.severity,
          confidence: row.confidence,
          category: row.category,
          cwe: row.cwe || null,
          status: row.status,
          dismissReason: row.dismissReason,
          impact: row.impact,
          mitigations: row.mitigations || null,
          entryPoint: finding.entryPoint,
          attackPath: finding.attackPath,
          attacker: row.attacker,
          preconditions: row.preconditions,
          proofOfConcept: row.proofOfConcept,
          fixGuidance: row.fixGuidance,
          guarantees: row.guarantees,
          mustNotBreak: row.mustNotBreak,
          regressionTest: row.regressionTest,
          alsoAffects: findingPlaces(row.alsoReported).map((place) => ({ title: place.title, at: place.at })),
          prNumber: row.prNumber,
          codeMoved: row.stale,
          firstSeenAt: row.firstSeenAt.toISOString(),
          lastSeenAt: row.lastSeenAt.toISOString(),
          fixedAt: row.fixedAt?.toISOString() ?? null,
        };
      }),
    },
    null,
    2,
  );
}

type Hop = { file: string; line: number; note: string; excerpt?: string };
type Entry = { file: string; line: number; description: string };

/** A stored finding as the prompt sections read it; code excerpts only when asked for. */
function promptFinding(row: ExportedFinding, options: { excerpts?: boolean } = {}): PromptFinding {
  const path = (row.attackPath as Hop[]).map(({ file, line, note, excerpt }) => ({ file, line, note, ...(options.excerpts && excerpt ? { excerpt } : {}) }));
  const entry = row.entryPoint as Entry;
  return { ...row, severity: row.severity as Severity, entryPoint: { file: entry.file, line: entry.line, description: entry.description }, attackPath: path, alsoReportedAs: findingPlaces(row.alsoReported) };
}

function sinkOf(row: ExportedFinding): string {
  const sink = (row.attackPath as Hop[]).at(-1);
  return sink ? `${sink.file}:${sink.line}` : "";
}

function statusOf(row: ExportedFinding): string {
  if (row.status === "dismissed") return row.dismissReason ? `Dismissed: ${DISMISS_REASON_LABEL[row.dismissReason]?.toLowerCase()}` : "Dismissed";
  if (row.status === "fixed") return row.fixedAt ? `Fixed ${shortDate(row.fixedAt)}` : "Fixed";
  return "Open";
}

/** "3 open findings · Critical, High · acme/app · low confidence included". */
function describe(rows: ExportedFinding[], context: ExportContext): string {
  const filters = context.filters;
  return [
    plural(rows.length, `${filters.status} finding`),
    filters.severities.map((severity) => SEVERITY_LABEL[severity]).join(", "),
    filters.repo ? rows[0]?.repoFullName : "",
    filters.includeLowConfidence ? "low confidence included" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Text that cannot break out of a Markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}
