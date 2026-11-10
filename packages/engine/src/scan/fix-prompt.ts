import type { Finding } from "./schema";

export type PromptFinding = Pick<Finding, "severity" | "title" | "cwe" | "impact" | "mitigations" | "entryPoint" | "preconditions" | "proofOfConcept" | "fixGuidance" | "guarantees" | "mustNotBreak" | "regressionTest"> & {
  attackPath: Array<Omit<Finding["attackPath"][number], "excerpt"> & { excerpt?: string }>;
  /** `Finding.alsoReportedAs`: the ones marked `variant` are the other places the finding affects, each with its title and the `file:line` it lands at. */
  alsoReportedAs?: Array<{ title: string; at: string; variant?: boolean }> | null;
};

/** How an agent should work a fix: prove the attack, close it, prove it closed. */
export const FIX_STEPS = "Write the regression test first and confirm it fails against the current code. Then make the smallest change that closes the attack path, and confirm the test passes along with the existing suite.";

/**
 * The canonical prompt a coding agent can act on: the vulnerability, how it
 * is reached, what the fix must guarantee, what must not break, and a
 * regression test that proves it.
 */
export function fixPrompt(finding: PromptFinding): string {
  return `Fix this ${finding.severity}-severity security vulnerability: ${finding.title}${finding.cwe ? ` (${finding.cwe})` : ""}.

${findingSections(finding)}

${FIX_STEPS}`;
}

export interface SectionOptions {
  /** The heading marker for each section, `##` by default. */
  heading?: string;
  /** Turns a cited location into a link. Left as code when absent. */
  link?: (file: string, line: number) => string;
}

/**
 * Everything about a finding a reader or an agent needs to fix it, as
 * Markdown sections: the vulnerability, the attack path, the proof of
 * concept, the fix, its guarantees, what must not break and the regression test.
 * A finding that affects other places names them after the fix; one that
 * affects none reads exactly as it did before a finding could.
 */
export function findingSections(finding: PromptFinding, options: SectionOptions = {}): string {
  const h = options.heading ?? "##";
  const at = (file: string, line: number) => (options.link ? `[\`${file}:${line}\`](${options.link(file, line)})` : `\`${file}:${line}\``);
  const sink = finding.attackPath.at(-1)!;
  const steps = finding.attackPath
    // Excerpts are dropped once a finding is resolved; the path still reads without them.
    .map((step, i) => `${i + 1}. ${at(step.file, step.line)} — ${step.note}${step.excerpt ? `\n\n${fence(step.excerpt)}` : ""}`)
    .join("\n\n");
  const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
  // Only the copies of the flaw elsewhere: a repeat report of this same code is closed by this fix.
  const places = (finding.alsoReportedAs ?? []).filter((report) => report.variant);
  const also = places.length
    ? `\n${h} Also affects\nThe same flaw is at ${places.length} other ${places.length === 1 ? "place" : "places"}. The fix is needed at each one, and the regression test should cover every one:\n${list(places.map((p) => `${place(p.at, at)}: ${p.title}`))}\n`
    : "";

  return `${h} The vulnerability
${finding.impact}
${finding.mitigations ? `\nAlready limiting the impact (still fix it): ${finding.mitigations}\n` : ""}
It is reached through ${finding.entryPoint.description} (${at(finding.entryPoint.file, finding.entryPoint.line)}) and lands at ${at(sink.file, sink.line)}.
Who can exploit it: ${finding.preconditions}

${h} Attack path
${steps}

${h} Proof of concept
${fence(finding.proofOfConcept)}

${h} How to fix it
${finding.fixGuidance}
${also}
${h} The fix must guarantee
${list(finding.guarantees)}
${finding.mustNotBreak.length ? `\n${h} It must not break\n${list(finding.mustNotBreak)}\n` : ""}
${h} Regression test
${finding.regressionTest}`;
}

/** A stored `file:line` as a cited location; left as written when it is not one. */
function place(text: string, at: (file: string, line: number) => string): string {
  const colon = text.lastIndexOf(":");
  const line = Number(text.slice(colon + 1));
  return colon > 0 && Number.isInteger(line) && line > 0 ? at(text.slice(0, colon), line) : `\`${text}\``;
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
}
