/**
 * Signal sweep: deterministic, cheap leads gathered before any model runs.
 * Secrets, reachable vulnerable dependencies and text addressed to reviewers
 * always appear in the scan output; the model may investigate and rank them,
 * never suppress them.
 */
import type { IndexerClient } from "../indexer/client";
import type { Advisory, OsvClient } from "./osv";
import type { Lead, Severity } from "./schema";
import type { Dependency, SinkInfo } from "./tools";

export interface DependencyVulns {
  ecosystem: string;
  name: string;
  version: string;
  reachability: Dependency["reachability"];
  importedAt: string[];
  advisories: Advisory[];
}

/**
 * Leads and advisories, shared by every agent's tools. Starts with what the
 * indexer found and gains vulnerable dependencies once the lookup returns.
 */
export interface Signals {
  leads: Lead[];
  vulns: DependencyVulns[];
}

export interface CodeSignals {
  found: LeadsResult;
  dependencies: Dependency[];
}

interface LeadsResult {
  secrets: Array<{ rule: string; at: string; redacted: string }>;
  injectionMarkers: Array<{ at: string; text: string }>;
  sinks: SinkInfo[];
}

/** Riskiest sinks handed to hunters as leads. */
const MAX_SINK_LEADS = 60;

/** What the index found: secrets, markers, sinks and dependencies. Milliseconds. */
export async function codeSignals(indexer: IndexerClient, signal?: AbortSignal): Promise<CodeSignals> {
  const [found, { dependencies }] = await Promise.all([
    indexer.call<LeadsResult>("leads", {}, signal),
    indexer.call<{ dependencies: Dependency[] }>("deps", {}, signal),
  ]);
  return { found, dependencies };
}

/** Known vulnerabilities for the dependencies. Network-bound; a failure leaves the scan without them. */
export async function vulnerabilities(
  osv: OsvClient | undefined,
  dependencies: Dependency[],
  signal?: AbortSignal,
): Promise<{ vulns: DependencyVulns[]; error?: string }> {
  if (!osv || dependencies.length === 0) return { vulns: [] };
  try {
    const advisories = await osv.query(dependencies, signal);
    const vulns = dependencies
      .map((dep, i) => ({ ...dep, importedAt: dep.importedAt ?? [], advisories: advisories[i] ?? [] }))
      .filter((dep) => dep.advisories.length > 0)
      .map(({ ecosystem, name, version, reachability, importedAt, advisories }) => ({ ecosystem, name, version, reachability, importedAt, advisories }));
    return { vulns };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { vulns: [], error: (error as Error).message };
  }
}

/** Numbers the leads: secrets, markers, vulnerable dependencies, then sinks. */
export function buildLeads({ found }: CodeSignals, vulns: DependencyVulns[]): Lead[] {
  const leads: Lead[] = [];
  const add = (lead: Omit<Lead, "id">) => leads.push({ id: `L${leads.length + 1}`, ...lead });

  for (const secret of found.secrets) {
    add({ kind: "secret", title: `Committed ${secret.rule.replaceAll("_", " ")}`, at: secret.at, detail: `value ${secret.redacted}` });
  }
  for (const marker of found.injectionMarkers) {
    add({ kind: "injection_marker", title: "Text addressed to an automated reviewer", at: marker.at, detail: marker.text });
  }
  // Imported packages first: those are the ones attacker input can reach.
  const ranked = [...vulns].sort((a, b) => reachRank(a) - reachRank(b) || severityRank(worst(a)) - severityRank(worst(b)));
  for (const dep of ranked) {
    const top = dep.advisories.slice(0, 4).map((a) => `${a.id} (${a.severity}${a.fixed ? `, fixed in ${a.fixed}` : ""}): ${a.summary}`);
    const where = dep.reachability === "imported" ? `imported at ${dep.importedAt.join(", ")}` : dep.reachability.replace("_", " ");
    add({
      kind: "vulnerable_dependency",
      title: `${dep.name}@${dep.version} has ${dep.advisories.length} known ${dep.advisories.length === 1 ? "vulnerability" : "vulnerabilities"}`,
      detail: `${where}. ${top.join("; ")}`,
      severity: toSeverity(worst(dep)),
    });
  }
  for (const sink of found.sinks.slice(0, MAX_SINK_LEADS)) {
    const reach = sink.reachable ? "" : " (no route reaches it)";
    add({ kind: "sink", title: `${sink.kind} sink with ${sink.input} input${reach}`, at: sink.at, detail: `in ${sink.in}: ${sink.code}` });
  }

  return leads;
}

/**
 * Leads as they may be stored (SPEC §16: never source code). An injection
 * marker's detail is the source line itself, so only its location and title
 * are kept; secrets are already redacted and advisories are not code.
 */
export function storableLeads(leads: Lead[]): Lead[] {
  return leads.map((lead) => (lead.kind === "injection_marker" ? { ...lead, detail: "" } : lead));
}

/** Leads that must be reported whatever the hunters conclude. */
export function persistentLeads(leads: Lead[]): Lead[] {
  return leads.filter((lead) => lead.kind !== "sink");
}

function reachRank(dep: DependencyVulns): number {
  return dep.reachability === "imported" ? 0 : dep.reachability === "unknown" ? 1 : 2;
}

const ORDER = ["critical", "high", "medium", "low", "unknown"] as const;

function worst(dep: DependencyVulns): Advisory["severity"] {
  return dep.advisories.reduce<Advisory["severity"]>((acc, a) => (ORDER.indexOf(a.severity) < ORDER.indexOf(acc) ? a.severity : acc), "unknown");
}

function severityRank(severity: Advisory["severity"]): number {
  return ORDER.indexOf(severity);
}

function toSeverity(severity: Advisory["severity"]): Severity | undefined {
  return severity === "unknown" ? undefined : severity;
}
