import type { Finding } from "./schema";

/**
 * The canonical prompt a coding agent can act on: the vulnerability, how it
 * is reached, what the fix must guarantee, what must not break, and a
 * regression test that proves it.
 */
export function fixPrompt(finding: Pick<Finding, "severity" | "title" | "cwe" | "impact" | "entryPoint" | "preconditions" | "proofOfConcept" | "fixGuidance" | "guarantees" | "mustNotBreak" | "regressionTest"> & { attackPath: Array<Omit<Finding["attackPath"][number], "excerpt"> & { excerpt?: string }> }): string {
  const sink = finding.attackPath.at(-1)!;
  const steps = finding.attackPath
    // Excerpts are dropped once a finding is resolved; the path still reads without them.
    .map((step, i) => `${i + 1}. \`${step.file}:${step.line}\` — ${step.note}${step.excerpt ? `\n\n${fence(step.excerpt)}` : ""}`)
    .join("\n\n");
  const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");

  return `Fix this ${finding.severity}-severity security vulnerability: ${finding.title}${finding.cwe ? ` (${finding.cwe})` : ""}.

## The vulnerability
${finding.impact}

It is reached through ${finding.entryPoint.description} and lands at \`${sink.file}:${sink.line}\`.
Who can exploit it: ${finding.preconditions}

## Attack path
${steps}

## Proof of concept
${fence(finding.proofOfConcept)}

## How to fix it
${finding.fixGuidance}

## The fix must guarantee
${list(finding.guarantees)}
${finding.mustNotBreak.length ? `\n## It must not break\n${list(finding.mustNotBreak)}\n` : ""}
## Regression test
${finding.regressionTest}

Write the regression test first and confirm it fails against the current code. Then make the smallest change that closes the attack path, and confirm the test passes along with the existing suite.`;
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
}
