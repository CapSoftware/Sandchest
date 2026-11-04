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
 * What fails the build. Measured against the labelled Cap set, the trust tier
 * does NOT separate real from false: a finding is `corroborated` when its path
 * is reachable, but the false positives are "a guard exists that the model
 * missed" — and those endpoints are reachable too, so 3 of 4 known FPs were
 * corroborated. Meanwhile 9 real findings (2 of them high) were unconfirmed.
 * So gating the merge-block on trust drops real high-severity findings while
 * still admitting reachable-but-guarded ones. Until a signal actually tracks
 * exploitability (runtime `verified`, or taint that sees the guard), the block
 * stays on severity + the skeptic; trust only ranks and labels. A runtime
 * reproduction is the one dispositive signal, so it fails even below threshold.
 */
function mayFailBuild(finding: Finding, threshold: Severity): boolean {
  if (finding.validation?.status === "verified") return true;
  return ORDER.indexOf(finding.severity) <= ORDER.indexOf(threshold);
}

export function checkResult(input: CheckInput): { conclusion: CheckConclusion; output: CheckOutput } {
  const visible = shown(input.findings);
  const failing = visible.filter((f) => mayFailBuild(f, input.threshold));
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
    ...(finding.mitigations ? [`**What limits the impact today:** ${finding.mitigations}`] : []),
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

/** Marks Sandchest's summary comment, so it can be told apart from anything else on the PR. */
export const SUMMARY_MARKER = "<!-- sandchest:summary -->";
/** GitHub refuses comments over 65,536 characters; past this the per-finding details are left to the dashboard. */
const COMMENT_LIMIT = 60_000;

export interface SummaryInput {
  /** What the review reported, dismissed findings already left out. Each links to its page in the dashboard. */
  findings: Array<Finding & { url: string }>;
  isPublic: boolean;
  /** The commit that was reviewed. */
  headSha: string;
  /** The review's page in the dashboard. */
  detailsUrl: string;
  credits?: number;
  /** How many findings were also placed as inline comments on the diff (private repos). */
  inline?: number;
}

/**
 * Sandchest's one comment on a pull request, edited in place after every
 * review so it always describes the latest commit. Public repositories get
 * counts and a private link, never what or where; private ones get each
 * finding with its full write-up folded away.
 */
export function prSummary(input: SummaryInput): string {
  const visible = shown(input.findings) as SummaryInput["findings"];
  const commit = `\`${input.headSha.slice(0, 7)}\``;
  const cost = input.credits ? ` · ${input.credits} ${input.credits === 1 ? "credit" : "credits"}` : "";
  const foot = `<sub>Sandchest reviews every change for vulnerabilities an attacker could use${cost} · [Review details](${input.detailsUrl})</sub>`;

  if (visible.length === 0) {
    return [SUMMARY_MARKER, `**Sandchest** reviewed ${commit}: nothing exploitable found in this change.`, foot].join("\n\n");
  }
  const counts = countBySeverity(visible);
  const issues = `${visible.length} ${visible.length === 1 ? "issue" : "issues"}`;
  if (input.isPublic) {
    return [
      SUMMARY_MARKER,
      `**Sandchest** found ${issues} in ${commit} (${counts}).`,
      `This repository is public, so the details stay private: [view them in the Sandchest dashboard →](${input.detailsUrl})`,
      `<sub>Only people who can push to this repository can see them.${cost ? ` Reviewed${cost}.` : ""}</sub>`,
    ].join("\n\n");
  }

  const rows = visible.map((f) => {
    const sink = f.attackPath.at(-1)!;
    return `| ${LABEL[f.severity]} | [${tableCell(f.title)}](${f.url}) | \`${tableCell(`${sink.file}:${sink.line}`)}\` |`;
  });
  const inline = input.inline ? ` ${input.inline} ${input.inline === 1 ? "is" : "are"} also commented on the diff.` : "";
  const head = [SUMMARY_MARKER, `**Sandchest** found ${issues} in ${commit}: ${counts}.${inline}`, ["| Severity | Issue | Where |", "| --- | --- | --- |", ...rows].join("\n")];
  const details = visible.map((f) => `<details><summary><b>${LABEL[f.severity]}</b> ${escapeHtml(f.title)}</summary>\n\n${reviewComment(f)}\n\n</details>`);
  const full = [...head, ...details, foot].join("\n\n");
  if (full.length <= COMMENT_LIMIT) return full;
  return [...head, `Full write-ups, proof and fix prompts are in the dashboard: [open the review →](${input.detailsUrl})`, foot].join("\n\n");
}

/**
 * The summary after a review that couldn't finish, so the PR never shows an
 * older commit's result as if it were current. Only ever edits an existing
 * summary: a PR that never had one gets the neutral Check alone.
 */
export function prSummaryUnfinished(input: { headSha: string; detailsUrl: string; reason: "failed" | "out_of_credits" | "no_plan" }): string {
  const commit = `\`${input.headSha.slice(0, 7)}\``;
  const why = {
    failed: `Sandchest couldn't finish reviewing ${commit}. Comment \`/sandchest review\` to try again; nothing was charged.`,
    out_of_credits: `Sandchest didn't review ${commit}: the account is out of credits.`,
    no_plan: `Sandchest didn't review ${commit}: the account has no plan.`,
  }[input.reason];
  return [SUMMARY_MARKER, `**Sandchest** · ${why}`, `<sub>[Details](${input.detailsUrl}) · earlier results on this pull request no longer apply to the latest commit.</sub>`].join("\n\n");
}

/** Text safe inside a Markdown table cell and link text: no pipes, brackets or line breaks. */
function tableCell(text: string): string {
  return escapeHtml(text).replace(/[|[\]]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, " ");
}
