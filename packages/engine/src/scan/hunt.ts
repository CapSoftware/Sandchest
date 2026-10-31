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
  ms: number;
  /** Why the hunter stopped early, if it did. */
  error?: string;
}

const MAX_ROUTES_LISTED = 150;
const MAX_LEADS_LISTED = 80;
/** Entry points one access-control hunter reviews; more are split across hunters. */
const ROUTES_PER_ACCESS_HUNTER = 60;
const MAX_ACCESS_HUNTERS = 2;
/** Sinks every scan must rule on when a route reaches them: the classic injection shapes. */
const HIGH_SIGNAL_SINK = /^(sql|nosql|command|code_eval|deserialization|xxe|template|ssrf|path) sink with (built|variable) input$/;
/** Items one coverage hunter checks. */
const COVERAGE_ITEMS_PER_HUNTER = 30;
const MAX_COVERAGE_HUNTERS = 2;

const ACCESS_CONTROL_BRIEF =
  "For each entry point, work out who can call it (anonymous, any user, admin) and whether it checks that the caller may act on the specific object it reads or changes. Look for missing auth middleware, inconsistent guards between similar routes, IDs taken from the request without an ownership check, role or ownership fields an attacker can set, broken session or token handling, and password reset or login flaws.";

/**
 * Splits the attack surface: one hunter per risky subsystem, access-control
 * hunters across every entry point (several when there are many, so no one
 * hunter becomes the long pole), and one for the deterministic leads.
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

  const accessGroups = chunk(routes, ROUTES_PER_ACCESS_HUNTER).slice(0, MAX_ACCESS_HUNTERS);
  // Access control, abuse and leads hunters always run; subsystems share the rest.
  const reserved = Math.max(1, accessGroups.length) + 2;
  for (const subsystem of subsystems.slice(0, Math.max(1, maxHunters - reserved))) {
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

  if (accessGroups.length <= 1) {
    assignments.push({
      name: "access control",
      brief: [
        "Your scope: authentication and authorisation across every entry point.",
        ACCESS_CONTROL_BRIEF,
        section("Entry points", routes.map(formatRoute), "None found by the index. Use search() to find handlers."),
      ].join("\n\n"),
    });
  } else {
    for (const [i, group] of accessGroups.entries()) {
      assignments.push({
        name: `access control ${i + 1}/${accessGroups.length}`,
        brief: [
          "Your scope: authentication and authorisation for the entry points below. Other hunters cover the rest; compare with similar routes elsewhere (routes()) when a guard looks inconsistent.",
          ACCESS_CONTROL_BRIEF,
          section("Entry points", group.map(formatRoute), ""),
        ].join("\n\n"),
      });
    }
  }

  assignments.push({
    name: "abuse",
    brief: [
      "Your scope: how the product can be abused, rather than broken into. Think like a fraudster and an abusive customer: what does this application let people get, spend, send or trigger, and how can you get more of it than you should, at someone else's expense?",
      "Look for: payments, plans and credits that can be skipped, reused, reversed or set by the client; coupons, referrals and trials that stack or reset; quantities, prices and currencies the client controls; steps that can be skipped, repeated or raced (two requests at once); invites, sharing and notifications that send attacker-chosen content to others; brute-forceable codes, passwords and tokens with no rate limit or lockout; user enumeration; and endpoints that make the owner pay per request (AI calls, transcoding, exports, storage, email) with no limit.",
      model.abuseSurfaces.length ? section("Worth abusing (from recon)", model.abuseSurfaces, "") : "",
      section("Entry points", routes.slice(0, MAX_ROUTES_LISTED).map(formatRoute), "None found by the index. Use search() to find handlers."),
    ]
      .filter(Boolean)
      .join("\n\n"),
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

/**
 * A second pass over what the first hunters left open: route handlers in
 * files no agent read, reachable sinks in such files, and high-signal sinks
 * (injection shapes) that no candidate cites even if someone read the file.
 * Hunters reach different code from run to run; this closes the gaps
 * deterministically.
 */
export function planCoverage(
  routes: RouteInfo[],
  leads: Lead[],
  read: ReadonlySet<string>,
  cited: ReadonlyArray<{ file: string; line: number }>,
  wrap: Wrap,
): Assignment[] {
  const unread = (at: string | undefined) => !!at && !read.has(fileOf(at));
  const uncited = (at: string | undefined) => {
    if (!at) return false;
    const file = fileOf(at);
    const line = Number(at.slice(file.length + 1));
    return !cited.some((hop) => hop.file === file && Math.abs(hop.line - line) <= 3);
  };
  const sinks = leads
    .filter((lead) => lead.kind === "sink" && !lead.title.includes("no route reaches it"))
    .filter((lead) => uncited(lead.at) && (unread(lead.at) || HIGH_SIGNAL_SINK.test(lead.title)))
    .map(formatLead);
  const handlers = routes
    // PHP scripts are their own handler; elsewhere an unresolved handler is usually third-party middleware.
    .filter((route) => (route.framework === "php" ? unread(route.at) : route.handlers.length > 0 && route.handlers.every((h) => unread(h.split(" @ ")[1]))))
    .map(formatRoute);
  const items = [...sinks, ...handlers];
  return chunk(items, COVERAGE_ITEMS_PER_HUNTER)
    .slice(0, MAX_COVERAGE_HUNTERS)
    .map((group, i, all) => ({
      name: all.length > 1 ? `coverage ${i + 1}/${all.length}` : "coverage",
      brief: [
        "Your scope: what the first pass left open. Each item below is a dangerous sink a route can reach that nobody has reported on, or an entry point whose handler nobody read. Rule on every one: read it, decide whether an attacker can exploit it, and report what is real. Skip anything that is clearly safe.",
        `## Unreviewed\n${wrap(group.join("\n"))}`,
      ].join("\n\n"),
    }));
}

export interface HunterLimits {
  /** Turns every hunter gets. */
  turns: number;
  /** Extra turns earned per accepted candidate: productive hunters keep digging, idle ones stop. */
  turnsPerFinding: number;
  maxTurns: number;
  /** Epoch ms by which the hunter must finish. */
  deadline: number;
}

/** Runs one hunter to completion. `onCandidate` receives each candidate that passes the gate. */
export async function runHunter(
  ctx: ScanContext,
  assignment: Assignment,
  registry: CandidateRegistry,
  limits: HunterLimits,
  onCandidate: (candidate: GatedCandidate) => void,
): Promise<HunterStats> {
  const started = Date.now();
  const stats: HunterStats = { name: assignment.name, turns: 0, toolCalls: 0, reported: 0, accepted: 0, ms: 0 };
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
    maxTurns: () => Math.min(limits.maxTurns, limits.turns + limits.turnsPerFinding * stats.accepted),
    deadline: limits.deadline,
    signal: ctx.signal,
  });
  stats.turns = result.turns;
  stats.toolCalls = result.toolCalls;
  stats.ms = Date.now() - started;
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

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

/** `src/a.ts:12` → `src/a.ts`. */
function fileOf(at: string): string {
  const colon = at.lastIndexOf(":");
  return colon === -1 ? at : at.slice(0, colon);
}

function formatRoute(route: RouteInfo): string {
  const chain = route.chain.length ? ` [${route.chain.join(" → ")}]` : "";
  return `- ${route.method} ${route.path} (${route.at})${chain}`;
}
