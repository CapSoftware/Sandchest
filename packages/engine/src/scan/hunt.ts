/**
 * Hunt: parallel attacker agents, each with its own slice of the attack
 * surface. Candidates are gated the moment they are reported, so the hunter
 * gets immediate feedback and verification starts while hunting continues.
 */
import { defineTool, type Message } from "../llm";
import { runAgent } from "./agent";
import { CandidateRegistry, checkEvidence, fingerprint, normalizePath, type GatedCandidate } from "./gate";
import { huntSystemPrompt } from "./prompts";
import { CandidateSchema, type Candidate, type Lead, type ThreatModel } from "./schema";
import { agentTool, formatLead, type AgentTool, type RouteInfo, type Wrap } from "./tools";
import type { ScanContext } from "./context";

export interface Assignment {
  name: string;
  brief: string;
}

export interface HunterStats {
  name: string;
  turns: number;
  toolCalls: number;
  reported: number;
  accepted: number;
}

const MAX_ROUTES_LISTED = 150;
const MAX_LEADS_LISTED = 80;

/**
 * Splits the attack surface: one hunter per risky subsystem, one for access
 * control across every entry point, and one for the deterministic leads.
 */
export function planAssignments(model: ThreatModel, routes: RouteInfo[], leads: Lead[], maxHunters: number, wrap: Wrap): Assignment[] {
  // Route paths and lead details come from the repository.
  const section = (title: string, lines: string[], empty: string) => `## ${title}\n${lines.length ? wrap(lines.join("\n")) : empty}`;
  const assignments: Assignment[] = [];
  const order = { high: 0, medium: 1, low: 2 } as const;
  const subsystems = [...model.subsystems].filter((s) => s.risk !== "low" || model.subsystems.length <= 2).sort((a, b) => order[a.risk] - order[b.risk]);
  const covered: string[] = [];
  /** Whether a `file:line` or path falls under one of `prefixes`. */
  const under = (prefixes: string[], at: string | undefined) =>
    !!at && prefixes.some((prefix) => prefix === "" || at === prefix || at.startsWith(`${prefix}/`) || at.startsWith(`${prefix}:`));

  for (const subsystem of subsystems.slice(0, Math.max(1, maxHunters - 2))) {
    const prefixes = subsystem.paths.map((p) => normalizePath(p).replace(/\/+$/, ""));
    covered.push(...prefixes);
    const inScope = (at: string | undefined) => under(prefixes, at);
    const scopedRoutes = routes.filter((r) => inScope(r.at) || r.handlers.some((h) => inScope(h.split(" @ ")[1])));
    const scopedLeads = leads.filter((lead) => inScope(lead.at));
    assignments.push({
      name: subsystem.name,
      brief: [
        `Your scope: the ${subsystem.name} subsystem (${subsystem.paths.join(", ")}). ${subsystem.description}`,
        "Hunt for every class of exploitable vulnerability in this scope. Follow data into other parts of the codebase when the attack path leads there.",
        section("Entry points in scope", scopedRoutes.slice(0, MAX_ROUTES_LISTED).map(formatRoute), "Use routes() and read the code to find them."),
        section("Leads in scope", scopedLeads.map(formatLead), "None from the sweep."),
      ].join("\n\n"),
    });
  }

  assignments.push({
    name: "access control",
    brief: [
      "Your scope: authentication and authorisation across every entry point.",
      "For each entry point, work out who can call it (anonymous, any user, admin) and whether it checks that the caller may act on the specific object it reads or changes. Look for missing auth middleware, inconsistent guards between similar routes, IDs taken from the request without an ownership check, role or ownership fields an attacker can set, broken session or token handling, and password reset or login flaws.",
      section("Entry points", routes.slice(0, MAX_ROUTES_LISTED * 2).map(formatRoute), "None found by the index. Use search() to find handlers."),
    ].join("\n\n"),
  });

  const unscoped = leads
    .filter((lead) => lead.kind !== "sink" || !under(covered, lead.at))
    .filter((lead) => lead.kind !== "vulnerable_dependency" || lead.detail.startsWith("imported"))
    .slice(0, MAX_LEADS_LISTED);
  if (unscoped.length > 0) {
    assignments.push({
      name: "leads",
      brief: [
        "Your scope: the deterministic leads from the signal sweep that no other hunter owns (deps(vulnerableOnly: true) lists every vulnerable dependency). Investigate each one and decide whether an attacker can exploit it. Report the ones that are real. For a vulnerable dependency, find whether attacker input reaches the vulnerable functionality. For a secret, find where the application uses it and what it unlocks.",
        section("Leads", unscoped.map(formatLead), ""),
      ].join("\n\n"),
    });
  }
  return assignments;
}

/** Runs one hunter to completion. `onCandidate` receives each candidate that passes the gate. */
export async function runHunter(
  ctx: ScanContext,
  assignment: Assignment,
  registry: CandidateRegistry,
  onCandidate: (candidate: GatedCandidate) => void,
): Promise<HunterStats> {
  const stats: HunterStats = { name: assignment.name, turns: 0, toolCalls: 0, reported: 0, accepted: 0 };
  const messages: Message[] = [
    { role: "system", content: `${huntSystemPrompt(ctx.tag)}\n\n${ctx.threatModelText}` },
    { role: "user", content: assignment.brief },
  ];
  const result = await runAgent({
    client: ctx.client,
    role: "hunt",
    messages,
    tools: [...ctx.tools, reportTool(ctx, assignment.name, registry, stats, onCandidate)],
    limiter: ctx.limiter,
    meter: ctx.meter,
    maxTurns: ctx.options.hunterTurns,
    signal: ctx.signal,
  });
  stats.turns = result.turns;
  stats.toolCalls = result.toolCalls;
  return stats;
}

const reportFinding = defineTool({
  name: "report_finding",
  description:
    "Report one exploitable vulnerability with full evidence. Every file:line must be a line you have read. The gate checks each citation and replies with the candidate id or what to fix.",
  args: CandidateSchema,
});

function reportTool(
  ctx: ScanContext,
  hunter: string,
  registry: CandidateRegistry,
  stats: HunterStats,
  onCandidate: (candidate: GatedCandidate) => void,
): AgentTool {
  return agentTool(reportFinding, async (candidate: Candidate) => {
    stats.reported++;
    const gate = await checkEvidence(ctx.indexer, candidate, ctx.signal);
    if (!gate.ok) {
      ctx.counters.rejected++;
      return `Not recorded. Fix these and report again:\n- ${gate.problems.join("\n- ")}`;
    }
    const sink = gate.path.at(-1)!;
    const print = fingerprint(candidate.category, sink);
    const existing = registry.find(candidate.category, gate.entry, gate.path, print, candidate.leads);
    if (existing) {
      ctx.counters.duplicates++;
      return `Already reported as ${existing.id} ("${existing.candidate.title}"). If this is a different vulnerability, cite its own sink.`;
    }

    const gated: GatedCandidate = {
      id: `C${registry.size + 1}`,
      candidate: { ...candidate, entryPoint: { ...candidate.entryPoint, file: gate.entry.file }, path: candidate.path.map((step, i) => ({ ...step, file: gate.path[i]!.file })) },
      entry: gate.entry,
      path: gate.path,
      fingerprint: print,
      hunter,
    };
    registry.add(gated);
    stats.accepted++;
    onCandidate(gated);
    return `Recorded as ${gated.id}. Keep hunting.`;
  });
}

function formatRoute(route: RouteInfo): string {
  const chain = route.chain.length ? ` [${route.chain.join(" → ")}]` : "";
  return `- ${route.method} ${route.path} (${route.at})${chain}`;
}
