/**
 * Merges confirmed findings that are the same issue reported twice. The
 * registry catches repeats while hunting by location (same sink, entry point
 * or path), but hunters often describe one root cause from two angles: as a
 * missing check in a controller and as a flaw in the model it calls, as code
 * execution and as a crash, as a dependency advisory and as the forged token
 * it enables. Those cite different lines under different categories, so only
 * a reading of what each finding says can tell they are one.
 *
 * One review over all of a scan's findings groups those that a single code
 * change fixes. The rule is deliberately narrow: the same missing check copied
 * into two handlers is two findings, because each needs its own fix. A merged
 * finding keeps the clearest write-up, the worst severity in its group, and a
 * note of what it absorbed; the absorbed findings are kept in the report for
 * auditing, never silently lost.
 */
import { z } from "zod";
import type { LlmClient } from "../llm";
import { generateObject } from "../llm";
import type { Usage } from "../llm/types";
import { isFatal, untilDeadline } from "./errors";
import type { Confidence, Finding, Severity, ValidationStatus } from "./schema";

export interface MergedFinding {
  /** Fingerprint of the finding it was merged into. */
  into: string;
  finding: Finding;
  reason: string;
}

export interface ConsolidateOptions {
  client: LlmClient;
  findings: Finding[];
  /** Marks untrusted text (finding write-ups quote the scanned code). */
  wrap?: (text: string) => string;
  signal?: AbortSignal;
  /** When to stop merging (epoch ms): findings not reviewed by then are returned unmerged. */
  deadline?: number;
  /** Runs the model call (a scan passes its limiter). */
  run?: <T>(task: () => Promise<T>) => Promise<T>;
}

export interface ConsolidateResult {
  findings: Finding[];
  merged: MergedFinding[];
  usage?: { usage: Usage; attempts: number; retries: number };
}

/** Above this, the review is split by sink file so each call stays small enough to read carefully. */
const BATCH = 60;

const GroupsSchema = z.object({
  groups: z
    .array(
      z.object({
        why: z.string().min(3).max(400).describe("First: the one flaw these findings share, and whether any rule for keeping findings apart applies."),
        fixAt: z.string().describe("file:line of the single change that fixes every finding in the group."),
        oneFix: z.boolean().describe("True only if that single change fixes every finding in the group and no keep-apart rule applies."),
        findings: z.array(z.string()).min(2).describe("Ids of the findings, e.g. [\"F2\", \"F7\"]."),
        keep: z.string().describe("Id of the finding whose write-up describes the flaw best."),
      }),
    )
    .max(40),
});

export const CONSOLIDATE_SYSTEM_PROMPT = `You review a security scan's confirmed findings before they are shown to a developer, and find the ones that report the same flaw more than once.

Findings report the same flaw only when they describe the same broken code, and one change to that code fixes every one of them:
- the same missing or broken check, reported at the route, the controller and the model it reaches;
- one flaw described by different consequences (code execution and a crash from the same eval; a forged token and the account takeover it gives; a server-side fetch and the attacker-controlled URL that drives it);
- a dependency advisory, and a finding that exploits that same vulnerable function of the dependency.

Keep findings apart whenever each needs its own change, and also when:
- the same mistake is repeated in separate handlers, endpoints, templates, pages or files. Each copy is its own finding, even when one global setting would fix them all (output escaping switched off globally makes every unescaped sink a separate finding);
- they are different attack techniques against the same code (accepting unsigned tokens, and confusing the key type, are two findings);
- they are different advisories in one dependency, or different flaws one upgrade happens to fix;
- one secret is exposed in two ways (committed in code, and served to the public), or two different secrets or keys are exposed;
- the same weakness affects different login forms, APIs or user flows.

When unsure, keep them apart: merging two real bugs hides one from the developer, while a duplicate only costs a minute. Return only groups of two or more where oneFix is true. Each finding id may appear in at most one group.`;

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const VALIDATION_RANK: Record<ValidationStatus, number> = { verified: 0, path_confirmed: 1, inconclusive: 2 };
const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

function render(finding: Finding, id: string): string {
  const step = (s: { file: string; line: number; note?: string; description?: string }) => `${s.file}:${s.line}${s.note || s.description ? ` ${(s.note ?? s.description)!.slice(0, 160)}` : ""}`;
  return [
    `### ${id}: ${finding.title}`,
    `${finding.severity} · ${finding.category}${finding.cwe ? ` (${finding.cwe})` : ""} · attacker: ${finding.attacker}`,
    `Entry: ${step(finding.entryPoint)}`,
    `Path:\n${finding.attackPath.map((s) => `- ${step(s)}`).join("\n")}`,
    `Impact: ${finding.impact.slice(0, 400)}`,
    `Fix: ${finding.fixGuidance.slice(0, 300)}`,
  ].join("\n");
}

function batches(findings: Finding[]): Finding[][] {
  if (findings.length <= BATCH) return [findings];
  // Findings about one issue nearly always share a file, so grouping by sink keeps them in one batch.
  const sorted = [...findings].sort((a, b) => a.attackPath.at(-1)!.file.localeCompare(b.attackPath.at(-1)!.file));
  const out: Finding[][] = [];
  for (let i = 0; i < sorted.length; i += BATCH) out.push(sorted.slice(i, i + BATCH));
  return out;
}

/** Folds `members` into `primary`: worst severity, best confidence, every lead, and a note of what was folded in. */
export function mergeInto(primary: Finding, members: Finding[]): Finding {
  const all = [primary, ...members];
  const severity = all.reduce((best, f) => (SEVERITY_RANK[f.severity] < SEVERITY_RANK[best] ? f.severity : best), primary.severity);
  const confidence = all.reduce((best, f) => (CONFIDENCE_RANK[f.confidence] < CONFIDENCE_RANK[best] ? f.confidence : best), primary.confidence);
  // The strongest evidence any report of the issue carries (validation only ever raises trust).
  const validation = all.map((f) => f.validation).filter((v) => !!v).sort((a, b) => VALIDATION_RANK[a.status] - VALIDATION_RANK[b.status])[0];
  const upgrades = members.filter((f) => f.category === "vulnerable_dependency" && primary.category !== "vulnerable_dependency").map((f) => f.fixGuidance);
  return {
    ...primary,
    severity,
    confidence,
    ...(validation && { validation }),
    fixGuidance: [primary.fixGuidance, ...upgrades].filter(Boolean).join(" "),
    leads: [...new Set(all.flatMap((f) => f.leads))],
    ...(primary.sources && { sources: [...new Set(all.flatMap((f) => f.sources ?? []))] }),
    alsoReportedAs: [
      ...(primary.alsoReportedAs ?? []),
      ...members.flatMap((f) => [
        { title: f.title, category: f.category, at: `${f.attackPath.at(-1)!.file}:${f.attackPath.at(-1)!.line}`, entry: `${f.entryPoint.file}:${f.entryPoint.line}` },
        ...(f.alsoReportedAs ?? []),
      ]),
    ],
  };
}

/**
 * Groups findings that are one issue and merges each group. Best-effort: if
 * the review fails, every finding is returned unchanged.
 */
export async function consolidateFindings(options: ConsolidateOptions): Promise<ConsolidateResult> {
  const { client, findings, signal } = options;
  if (findings.length < 2) return { findings, merged: [] };
  const wrap = options.wrap ?? ((text: string) => text);
  const run = options.run ?? (<T>(task: () => Promise<T>) => task());
  const usage: Usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let attempts = 0;
  let retries = 0;
  const absorbed = new Map<Finding, { into: Finding; reason: string }>();
  const primaries = new Map<Finding, Finding[]>();

  for (const batch of batches(findings)) {
    if (batch.length < 2) continue;
    if (options.deadline !== undefined && Date.now() >= options.deadline) break;
    const ids = new Map<string, Finding>(batch.map((f, i) => [`F${i + 1}`, f]));
    let groups: z.infer<typeof GroupsSchema>["groups"];
    try {
      const result = await run(() =>
        generateObject(client, {
          role: "skeptic",
          name: "duplicate_groups",
          schema: GroupsSchema,
          messages: [
            { role: "system", content: CONSOLIDATE_SYSTEM_PROMPT },
            { role: "user", content: `${wrap([...ids].map(([id, f]) => render(f, id)).join("\n\n"))}\n\nWhich of these findings are the same issue?` },
          ],
          signal: untilDeadline(signal, options.deadline),
        }),
      );
      for (const key of Object.keys(usage) as Array<keyof Usage>) usage[key] += result.usage[key];
      attempts += result.attempts;
      retries += result.retries;
      groups = result.value.groups;
    } catch (error) {
      if (isFatal(error, signal)) throw error;
      continue;
    }
    for (const group of groups) {
      if (!group.oneFix) continue;
      const members = [...new Set(group.findings)].map((id) => ids.get(id)).filter((f): f is Finding => !!f && !absorbed.has(f) && !primaries.has(f));
      if (members.length < 2) continue;
      const keep = ids.get(group.keep);
      const primary = keep && members.includes(keep) ? keep : members[0]!;
      const rest = members.filter((f) => f !== primary);
      primaries.set(primary, rest);
      for (const f of rest) absorbed.set(f, { into: primary, reason: group.why });
    }
  }

  const merged: MergedFinding[] = [];
  const out: Finding[] = [];
  for (const finding of findings) {
    if (absorbed.has(finding)) continue;
    const members = primaries.get(finding);
    if (!members) {
      out.push(finding);
      continue;
    }
    out.push(mergeInto(finding, members));
    for (const member of members) merged.push({ into: finding.fingerprint, finding: member, reason: absorbed.get(member)!.reason });
  }
  return { findings: out, merged, usage: attempts ? { usage, attempts, retries } : undefined };
}
