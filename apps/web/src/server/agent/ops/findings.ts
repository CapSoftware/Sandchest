/** Findings: what the hacker found, the evidence for it, the fix prompt, and the person's decisions. */
import { applyFindingAction, dashboardFindings, dashboardOverview, findingForUser, findingsForExport, findingStatusCounts, recordPromptCopied, recordPromptsCopied } from "@sandchest/db";
import { exportFindings } from "@/lib/findings-export";
import { fixPrompt } from "@sandchest/engine/fix-prompt";
import type { PathStep } from "@sandchest/engine/scan";
import { z } from "zod";
import { db } from "../../db";
import { ApiError, notFound } from "../errors";
import { flag, int, operation, RepoRef, SEVERITY, Uuid } from "../operation";
import { resolveRepo } from "../resolve";
import { findingListView, iso } from "../views";

type Step = Omit<PathStep, "excerpt"> & { excerpt?: string };

const Severities = z
  .union([SEVERITY, z.array(SEVERITY), z.string().regex(/^(critical|high|medium|low)(,(critical|high|medium|low))*$/)])
  .describe('One severity, a list, or a comma-separated string ("critical,high").');

function severitiesOf(value: z.infer<typeof Severities> | undefined): z.infer<typeof SEVERITY>[] | undefined {
  if (!value) return undefined;
  return (Array.isArray(value) ? value : value.split(",")) as z.infer<typeof SEVERITY>[];
}
type Entry = { file: string; line: number; description: string };

async function loadFinding(userId: string, id: string) {
  const row = await findingForUser(db(), userId, id);
  if (!row) throw notFound("finding");
  return row;
}

/** The prompt a coding agent fixes the finding from: stored at scan time, rebuilt for findings stored before prompts were. */
function promptOf(finding: Awaited<ReturnType<typeof loadFinding>>["finding"]): string | null {
  if (finding.status !== "open") return null;
  return finding.fixPrompt || fixPrompt({ ...finding, entryPoint: finding.entryPoint as Entry, attackPath: finding.attackPath as Step[] });
}

function findingView(row: Awaited<ReturnType<typeof loadFinding>>, appUrl: string) {
  const { finding, repo, history } = row;
  const entry = finding.entryPoint as Entry;
  const path = finding.attackPath as Step[];
  return {
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    confidence: finding.confidence,
    status: finding.status,
    dismiss_reason: finding.dismissReason,
    category: finding.category,
    cwe: finding.cwe,
    repo: { id: repo.id, full_name: repo.fullName, default_branch: repo.defaultBranch },
    impact: finding.impact,
    mitigations: finding.mitigations || null,
    attacker: finding.attacker,
    preconditions: finding.preconditions,
    entry_point: entry,
    attack_path: path.map((step) => ({ file: step.file, line: step.line, note: step.note, ...(step.excerpt && { excerpt: step.excerpt }) })),
    proof_of_concept: finding.proofOfConcept,
    fix: {
      guidance: finding.fixGuidance,
      guarantees: finding.guarantees,
      must_not_break: finding.mustNotBreak,
      regression_test: finding.regressionTest,
    },
    fix_prompt: promptOf(finding),
    evidence: { trust: finding.trust, validation: finding.validation },
    found_by: finding.sourceKind === "pr_review" ? { kind: "pr_review", pr_number: finding.prNumber, scan_id: finding.sourceScanId } : { kind: finding.sourceKind, scan_id: finding.sourceScanId },
    first_seen_at: iso(finding.firstSeenAt),
    last_seen_at: iso(finding.lastSeenAt),
    fixed_at: iso(finding.fixedAt),
    stale: finding.staleAt !== null,
    history: history.map((event) => ({ type: event.type, at: iso(event.at), by: event.login, scan_id: event.scanId })),
    url: `${appUrl}/dashboard/findings/${finding.id}`,
  };
}

export const findingOps = [
  operation({
    name: "list_findings",
    title: "List findings",
    description:
      "Findings across every repository the person can see, most severe first. Defaults to open findings with low-confidence ones hidden, as the dashboard shows them. Each has a location (the vulnerable line); call get_finding for the attack path, proof of concept and fix prompt.",
    method: "GET",
    path: "/findings",
    input: z.object({
      status: z.enum(["open", "fixed", "dismissed"]).optional().describe("Default open."),
      severity: Severities.optional(),
      repo: RepoRef.optional(),
      include_low_confidence: flag().optional(),
      limit: int(1, 300).optional().describe("At most this many (default 100)."),
    }),
    readOnly: true,
    async run(context, input) {
      const repo = input.repo ? (await resolveRepo(context, input.repo)).repo : undefined;
      const severities = severitiesOf(input.severity);
      const filters = { repoId: repo?.id, severities, includeLowConfidence: input.include_low_confidence };
      const [findings, counts] = await Promise.all([
        dashboardFindings(db(), context.principal.userId, { ...filters, status: input.status ?? "open" }, input.limit ?? 100),
        findingStatusCounts(db(), context.principal.userId, filters),
      ]);
      return { findings: findings.map((finding) => findingListView(finding, context.appUrl)), counts };
    },
  }),

  operation({
    name: "get_findings_prompt",
    title: "One prompt for many findings",
    description:
      "The findings list as one document, filtered like list_findings: format \"prompt\" (default) is a single prompt for a coding agent to fix every open finding in it, confirming each with a failing regression test first; \"markdown\" is a report with links; \"json\" is the data without code excerpts. Prefer filtering to one repository: the agent fixes only the findings in its own checkout.",
    method: "GET",
    path: "/findings/prompt",
    input: z.object({
      format: z.enum(["prompt", "markdown", "json"]).optional().describe("Default prompt."),
      status: z.enum(["open", "fixed", "dismissed"]).optional().describe("Default open. Prompts need open findings."),
      severity: Severities.optional(),
      repo: RepoRef.optional(),
      include_low_confidence: flag().optional(),
    }),
    readOnly: true,
    async run(context, input) {
      const format = input.format ?? "prompt";
      const status = input.status ?? "open";
      if (format === "prompt" && status !== "open") throw new ApiError(422, "not_open", "Only open findings can be handed to an agent. Use format markdown or json for fixed or dismissed ones.");
      const repo = input.repo ? (await resolveRepo(context, input.repo)).repo : undefined;
      const severities = severitiesOf(input.severity) ?? [];
      const includeLowConfidence = input.include_low_confidence ?? false;
      const rows = await findingsForExport(db(), context.principal.userId, { status, severities, repoId: repo?.id, includeLowConfidence });
      const text = exportFindings(rows, format, { baseUrl: context.appUrl, filters: { status, severities, repo: repo?.id, includeLowConfidence } });
      if (format === "prompt") await recordPromptsCopied(db(), context.principal.userId, rows.map((row) => row.id));
      return { format, findings: rows.length, repos: [...new Set(rows.map((row) => row.repoFullName))], text };
    },
  }),

  operation({
    name: "get_finding",
    title: "Get a finding",
    description:
      "Everything about one finding: impact, who can exploit it and how (entry point, attack path with code excerpts, proof of concept), how to fix it without breaking anything, and `fix_prompt`, a ready-to-run prompt for a coding agent. Excerpts and the prompt are removed once a finding is fixed or dismissed.",
    method: "GET",
    path: "/findings/{id}",
    input: z.object({ id: Uuid("finding") }),
    readOnly: true,
    async run(context, input) {
      return findingView(await loadFinding(context.principal.userId, input.id), context.appUrl);
    },
  }),

  operation({
    name: "get_fix_prompt",
    title: "Get a fix prompt",
    description:
      "The ready-to-run prompt that fixes an open finding: hand it to a coding agent (or follow it yourself) in a checkout of the repository. It names the vulnerable code, the fix, what must keep working, and a regression test to add. Once the fix is merged to the default branch, Sandchest checks it and marks the finding fixed.",
    method: "GET",
    path: "/findings/{id}/fix-prompt",
    input: z.object({ id: Uuid("finding") }),
    readOnly: true,
    async run(context, input) {
      const row = await loadFinding(context.principal.userId, input.id);
      const prompt = promptOf(row.finding);
      if (!prompt) throw new ApiError(409, "not_open", `This finding is ${row.finding.status}, so it has no fix prompt. Reopen it with update_finding first.`);
      await recordPromptCopied(db(), context.principal.userId, input.id);
      return { finding_id: input.id, repo: row.repo.fullName, prompt };
    },
  }),

  operation({
    name: "update_finding",
    title: "Fix, dismiss or reopen a finding",
    description:
      'Records the person\'s decision on a finding. status "dismissed" needs a reason (false_positive, accepted_risk, wont_fix); "fixed" marks it fixed by hand (Sandchest also detects fixes merged to the default branch); "open" reopens a fixed or dismissed one. Resolving a finding deletes its code excerpts and fix prompt.',
    method: "PATCH",
    path: "/findings/{id}",
    input: z.object({
      id: Uuid("finding"),
      status: z.enum(["dismissed", "fixed", "open"]),
      reason: z.enum(["false_positive", "accepted_risk", "wont_fix"]).optional().describe('Why it\'s dismissed. Required with status "dismissed".'),
    }),
    destructive: true,
    idempotent: true,
    async run(context, input) {
      if (input.status === "dismissed" && !input.reason) throw new ApiError(422, "reason_required", 'Dismissing needs a reason: "false_positive", "accepted_risk" or "wont_fix".');
      const action = input.status === "dismissed" ? { type: "dismiss" as const, reason: input.reason! } : input.status === "fixed" ? { type: "fix" as const } : { type: "reopen" as const };
      if (!(await applyFindingAction(db(), context.principal.userId, input.id, action))) {
        const row = await loadFinding(context.principal.userId, input.id);
        if (row.finding.status !== input.status) throw new ApiError(409, "invalid_transition", `This finding is ${row.finding.status}; only open findings can be dismissed or fixed, and only resolved ones reopened.`);
      }
      const row = await loadFinding(context.principal.userId, input.id);
      return { id: input.id, status: row.finding.status, dismiss_reason: row.finding.dismissReason, url: `${context.appUrl}/dashboard/findings/${input.id}` };
    },
  }),

  operation({
    name: "get_overview",
    title: "Overview",
    description: "Totals across every repository the person can see over the last `days`: pull requests reviewed, deep scans, findings found and fixed, credits spent, open findings by severity, and a per-day series. Compared with the window before.",
    method: "GET",
    path: "/overview",
    input: z.object({ days: int(1, 90).optional().describe("Window length in days (default 30).") }),
    readOnly: true,
    async run(context, input) {
      const overview = await dashboardOverview(db(), context.principal.userId, input.days ?? 30);
      const window = (w: typeof overview.now) => ({ pull_requests_reviewed: w.pullRequests, reviews: w.reviews, deep_scans: w.deepScans, found: w.found, fixed: w.fixed, credits_spent: w.credits });
      return { days: input.days ?? 30, now: window(overview.now), before: window(overview.before), open_findings: overview.open, series: overview.days };
    },
  }),
];
