/**
 * What Sandchest posts on GitHub. Public repositories get counts and a link
 * only: their Checks and comments are public, so details stay in the
 * dashboard.
 */
import type { Finding, Severity } from "@sandchest/engine/scan";
import type { CheckConclusion, CheckOutput } from "./app";

const ORDER: Severity[] = ["critical", "high", "medium", "low"];
const LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

/** Findings shown by default: everything except low confidence. */
export function shown(findings: Finding[]): Finding[] {
  return findings.filter((finding) => finding.confidence !== "low");
}

export interface CheckInput {
  findings: Finding[];
  /** Lowest severity that fails the Check. */
  threshold: Severity;
  isPublic: boolean;
  /** Where the full findings live. */
  detailsUrl: string;
  credits?: number;
  /** Findings that were placed as inline comments, for the summary. */
  inline?: number;
}

/**
 * A finding may fail the build unless we positively know it is a lone,
 * uncorroborated model judgment. Anything with independent evidence
 * (`corroborated`/`confirmed`) fails; so does anything with unknown trust
 * (older findings, or paths that did not set it) — we only ever *relax* the
 * build-blocking signal when we are sure, never guess a real issue away.
 */
function mayFailBuild(finding: Finding): boolean {
  return finding.trust !== "unconfirmed";
}

export function checkResult(input: CheckInput): { conclusion: CheckConclusion; output: CheckOutput } {
  const visible = shown(input.findings);
  const failing = visible.filter((f) => ORDER.indexOf(f.severity) <= ORDER.indexOf(input.threshold) && mayFailBuild(f));
  const cost = input.credits ? ` · ${input.credits} ${input.credits === 1 ? "credit" : "credits"}` : "";

  if (visible.length === 0) {
    return { conclusion: "success", output: { title: "Nothing buried here", summary: `Reviewed${cost}. No exploitable issues found in this change.` } };
  }
  const counts = countBySeverity(visible);
  const title = `Found ${visible.length} ${visible.length === 1 ? "issue" : "issues"}: ${counts}`;
  if (input.isPublic) {
    return {
      conclusion: failing.length > 0 ? "failure" : "success",
      output: { title, summary: `Reviewed${cost}. ${publicSentence(visible)} [View privately →](${input.detailsUrl})` },
    };
  }
  const list = visible
    .map((f) => `- **${LABEL[f.severity]}** ${f.title} — \`${f.attackPath.at(-1)!.file}:${f.attackPath.at(-1)!.line}\``)
    .join("\n");
  const inline = input.inline ? ` ${input.inline} placed inline on the diff.` : "";
  return {
    conclusion: failing.length > 0 ? "failure" : "success",
    output: { title, summary: `Reviewed${cost}.${inline} [Full details →](${input.detailsUrl})\n\n${list}` },
  };
}

/**
 * The Check for a PR that was not reviewed because of billing. Neutral, so it
 * never blocks a merge (SPEC §4).
 */
export function notReviewed(reason: "no_plan" | "out_of_credits", billingUrl: string, credits?: number): { conclusion: CheckConclusion; output: CheckOutput } {
  if (reason === "no_plan") {
    return { conclusion: "neutral", output: { title: "Not reviewed: no plan", summary: `Sandchest needs a plan before it reviews pull requests. [Pick a plan →](${billingUrl})` } };
  }
  const need = credits ? ` This review needs ${credits} ${credits === 1 ? "credit" : "credits"}.` : "";
  return { conclusion: "neutral", output: { title: "Out of credits", summary: `This change was not reviewed.${need} [Top up to keep reviewing →](${billingUrl})` } };
}

/** The one-line public summary: severity counts and nothing else. */
export function publicSentence(findings: Finding[]): string {
  const worst = ORDER.find((severity) => findings.some((f) => f.severity === severity))!;
  const count = findings.filter((f) => f.severity === worst).length;
  const more = findings.length - count;
  const head = `Sandchest found ${count} ${worst}-severity ${count === 1 ? "issue" : "issues"}`;
  return more > 0 ? `${head} and ${more} more.` : `${head}.`;
}

/** An inline review comment for a private repository. */
export function reviewComment(finding: Finding): string {
  const path = finding.attackPath.map((step, i) => `${i + 1}. \`${step.file}:${step.line}\` — ${step.note}`).join("\n");
  return [
    `**${LABEL[finding.severity]}** · ${finding.confidence} confidence${finding.cwe ? ` · ${finding.cwe}` : ""}`,
    `### ${finding.title}`,
    finding.impact,
    `**Who can exploit it:** ${finding.preconditions}`,
    `**Attack path**\n${path}`,
    `**Proof of concept**\n${fence(finding.proofOfConcept)}`,
    `**Fix:** ${finding.fixGuidance}`,
    `<details><summary>Fix prompt for your coding agent</summary>\n\n${fence(finding.fixPrompt)}\n\n</details>`,
  ].join("\n\n");
}

/** Review body: a summary, plus findings whose lines are outside the diff. */
export function reviewBody(findings: Finding[], unplaced: Finding[], detailsUrl: string): string {
  const head = `Sandchest found ${findings.length} ${findings.length === 1 ? "issue" : "issues"} in this change (${countBySeverity(findings)}). [Full details →](${detailsUrl})`;
  if (unplaced.length === 0) return head;
  const rest = unplaced.map((finding) => `<details><summary><b>${LABEL[finding.severity]}</b> ${escapeHtml(finding.title)}</summary>\n\n${reviewComment(finding)}\n\n</details>`);
  return `${head}\n\nThese could not be placed on the diff:\n\n${rest.join("\n\n")}`;
}

function countBySeverity(findings: Finding[]): string {
  return ORDER.map((severity) => [severity, findings.filter((f) => f.severity === severity).length] as const)
    .filter(([, n]) => n > 0)
    .map(([severity, n]) => `${n} ${severity}`)
    .join(", ");
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}\n${text}\n${ticks}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
