/**
 * Recon: builds the threat model. A short exploration (no reasoning) over the
 * deterministic inventory, then one structured call that writes the model.
 */
import { generateObject } from "../llm";
import { runAgent } from "./agent";
import type { ScanContext } from "./context";
import { errorMessage, isFatal, untilDeadline } from "./errors";
import { reconSystemPrompt } from "./prompts";
import { ThreatModelSchema, type Lead, type ThreatModel } from "./schema";
import { formatLead, type RouteInfo } from "./tools";

export interface Overview {
  files: number;
  sourceFiles: number;
  testFiles: number;
  loc: number;
  languages: Array<{ language: string; files: number; loc: number }>;
  topDirectories: Array<{ path: string; files: number; loc: number }>;
  routes: number;
  routeFrameworks: Record<string, number>;
  sinks: Record<string, Record<string, number>>;
  secrets: number;
  injectionMarkers: number;
  dependencies: { total: number; direct: number };
  manifests: string[];
  indexMs: number;
}

const MAX_ROUTES = 120;

export async function recon(
  ctx: Omit<ScanContext, "threatModelText">,
  overview: Overview,
  routes: RouteInfo[],
  leads: Lead[],
): Promise<ThreatModel> {
  const inventory = ctx.wrap(renderInventory(overview, routes, leads));
  const system = { role: "system" as const, content: reconSystemPrompt(ctx.tag) };
  let notes = "";

  try {
    const exploration = await runAgent({
      client: ctx.client,
      role: "recon",
      messages: [
        system,
        {
          role: "user",
          content: `${inventory}\n\nExplore what you need to understand the attack surface, then reply with concise notes (under 800 words): stack, entry points and their auth, how auth works and where it is enforced, sensitive data, sinks, protections, and the subsystems to review separately.`,
        },
      ],
      tools: ctx.tools,
      limiter: ctx.limiter,
      meter: ctx.meter,
      maxTurns: ctx.options.reconTurns,
      // Notes, not an essay: the structured pass below does the writing.
      maxTokens: 4_000,
      deadline: ctx.deadline,
      signal: ctx.signal,
    });
    notes = exploration.content;
    ctx.emit({ type: "progress", message: `Explored in ${exploration.turns} turns. Writing the threat model…` });

    const result = await ctx.limiter.run(() =>
      generateObject(ctx.client, {
        role: "recon",
        name: "threat_model",
        schema: ThreatModelSchema,
        maxTokens: 12_000,
        messages: [
          system,
          {
            role: "user",
            content: `${inventory}\n\nExploration notes:\n${notes || "(none)"}\n\nWrite the threat model. Subsystems must use real directory or file paths from the inventory, and together cover the code an attacker can reach.`,
          },
        ],
        signal: untilDeadline(ctx.signal, ctx.deadline),
      }),
    );
    ctx.meter.add("recon", result.usage, result.attempts, result.retries);
    return result.value;
  } catch (error) {
    // Hunting without a map is worse, but still far better than no scan.
    if (isFatal(error, ctx.signal)) throw error;
    ctx.emit({ type: "warning", message: `Could not build a threat model (${errorMessage(error)}); hunting by directory instead.` });
    return fallbackThreatModel(overview, notes);
  }
}

/** A threat model from the inventory alone: one subsystem per large top-level directory. */
function fallbackThreatModel(overview: Overview, notes: string): ThreatModel {
  const dirs = [...overview.topDirectories].sort((a, b) => b.loc - a.loc).slice(0, 6);
  return {
    summary: notes.slice(0, 2_000) || "No summary available.",
    stack: overview.languages.map((l) => l.language),
    entryPoints: [],
    authModel: "Unknown; establish it from the code.",
    trustBoundaries: [],
    sensitiveAssets: [],
    dangerousSinks: [],
    frameworkProtections: [],
    abuseSurfaces: [],
    subsystems: dirs.map((d) => ({ name: d.path, paths: [d.path === "." ? "" : d.path], description: `${d.files} files`, risk: "medium" as const })),
  };
}

function renderInventory(overview: Overview, routes: RouteInfo[], leads: Lead[]): string {
  const languages = overview.languages.map((l) => `${l.language} ${l.files} files, ${l.loc} LOC`).join("; ");
  const dirs = overview.topDirectories.map((d) => `- ${d.path}/ (${d.files} files, ${d.loc} LOC)`).join("\n");
  const frameworks = Object.entries(overview.routeFrameworks).map(([name, count]) => `${name}: ${count}`).join(", ");
  const sinks = Object.entries(overview.sinks)
    .map(([kind, inputs]) => `${kind} (${Object.entries(inputs).map(([input, n]) => `${n} ${input}`).join(", ")})`)
    .join("; ");
  const routeLines = routes.slice(0, MAX_ROUTES).map((r) => `- ${r.method} ${r.path} (${r.at})${r.chain.length ? ` [${r.chain.join(" → ")}]` : ""}`);
  const more = routes.length > MAX_ROUTES ? `\n(${routes.length - MAX_ROUTES} more; use routes())` : "";
  const leadLines = leads.filter((l) => l.kind !== "sink").slice(0, 40).map(formatLead);

  return `# Inventory
Source: ${overview.sourceFiles} files, ${overview.loc} LOC (${languages}). Tests: ${overview.testFiles} files.
Manifests: ${overview.manifests.join(", ") || "none"}. Dependencies: ${overview.dependencies.total} (${overview.dependencies.direct} direct).

## Top-level directories
${dirs}

## Entry points (${overview.routes}; ${frameworks || "none detected"})
${routeLines.join("\n")}${more}

## Sinks by kind
${sinks || "none"}

## Leads
${leadLines.join("\n") || "none"}`;
}
