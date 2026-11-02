/**
 * Signal sweep: deterministic, cheap leads gathered before any model runs.
 * Secrets, reachable vulnerable dependencies and text addressed to reviewers
 * always appear in the scan output; the model may investigate and rank them,
 * never suppress them.
 */
import type { IndexerClient } from "../indexer/client";
import { fixPrompt } from "./fix-prompt";
import { fingerprint } from "./gate";
import type { Advisory, OsvClient } from "./osv";
import { isNonProductAt, productFirst } from "./paths";
import type { Finding, Lead, Severity } from "./schema";
import type { Dependency, SinkInfo } from "./tools";

export interface DependencyVulns {
  ecosystem: string;
  name: string;
  version: string;
  /** A dev/build/test dependency, not shipped in the product. */
  dev: boolean;
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
      .map(({ ecosystem, name, version, dev, reachability, importedAt, advisories }) => ({ ecosystem, name, version, dev, reachability, importedAt, advisories }));
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

  // Product code before test/fixture code: a committed secret in `tests/` matters far less than one in the app.
  for (const secret of productFirst(found.secrets, (s) => s.at)) {
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
  // Reachable, then product-before-fixture, then take the budget: hunters see the sinks that ship first.
  const rankedSinks = productFirst([...found.sinks].sort((a, b) => Number(b.reachable) - Number(a.reachable)), (s) => s.at);
  for (const sink of rankedSinks.slice(0, MAX_SINK_LEADS)) {
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

/**
 * Findings emitted deterministically for a known **critical** advisory in a
 * dependency that is actually shipped — so the highest-severity known-vulnerable
 * dependencies are reported every run rather than only when a hunter happens to
 * surface them (a measured source of run-to-run variance, e.g. the next@16.3
 * image-optimizer RCE). Deliberately conservative, to stay credible rather than
 * turn into a dependency-audit firehose (measured on Cap, where a looser rule
 * emitted 21 findings — dev tooling, config files and three copies of the same
 * package):
 *   - critical only (high advisories go to the leads hunter, which weighs exploitability);
 *   - never a dev/build/test dependency (`dep.dev`);
 *   - must have at least one *product* import site (not a test, dot-directory or config file);
 *   - one finding per package, and none a hunter already reported.
 * These are software-composition facts, so they are `corroborated` by
 * construction and skip the gate and skeptic.
 */
export function dependencyFindings(vulns: DependencyVulns[], already: Finding[]): Finding[] {
  const covered = new Set(already.filter((f) => f.category === "vulnerable_dependency").map((f) => f.title.split(/[@\s]/)[0]!.toLowerCase()));
  const emitted = new Set<string>();
  const findings: Finding[] = [];
  for (const dep of vulns) {
    if (dep.dev || dep.reachability !== "imported") continue;
    if (worst(dep) !== "critical") continue;
    const name = dep.name.toLowerCase();
    if (covered.has(name) || emitted.has(name)) continue;
    const site = (dep.importedAt ?? []).find((s) => !isNonProductAt(s));
    if (!site) continue; // imported only by tooling, tests or config — not the product's attack surface

    emitted.add(name);
    const file = site.includes(":") ? site.slice(0, site.lastIndexOf(":")) : site;
    const line = Number(site.slice(file.length + 1)) || 1;
    const top = dep.advisories.filter((a) => a.severity === "critical").slice(0, 3);
    const ids = top.map((a) => a.id).join(", ");
    const fixedIn = top.map((a) => a.fixed).find(Boolean);
    const base: Omit<Finding, "fixPrompt"> = {
      fingerprint: fingerprint("vulnerable_dependency", { file, line, text: `${dep.name}@${dep.version} ${ids}`, symbol: dep.name }),
      title: `${dep.name}@${dep.version} ships a known critical vulnerability (${ids})`,
      severity: "critical",
      confidence: "high",
      category: "vulnerable_dependency",
      cwe: null,
      impact: top[0]?.summary ?? `${dep.name} has a known critical vulnerability.`,
      mitigations: "",
      entryPoint: { file, line, description: `${dep.name}@${dep.version} imported here` },
      attackPath: [{ file, line, note: `Vulnerable dependency ${dep.name}@${dep.version} is imported and reachable here`, excerpt: "" }],
      attacker: "unauthenticated",
      preconditions: `The project depends on ${dep.name}@${dep.version}, which is imported into shipped code.`,
      proofOfConcept: `${dep.name}@${dep.version} is affected by ${ids}: ${top[0]?.summary ?? "see the advisory"}. Consult the advisory for a working exploit against this version.`,
      fixGuidance: fixedIn ? `Upgrade ${dep.name} to ${fixedIn} or later.` : `Upgrade ${dep.name} to a patched version, or remove the dependency.`,
      guarantees: [`The project no longer depends on a version of ${dep.name} affected by ${ids}.`],
      mustNotBreak: [],
      regressionTest: `After upgrading, re-run the scan and confirm ${ids} no longer appears for ${dep.name}.`,
      leads: [],
      skeptic: { confidence: "high", reasoning: "Deterministic software-composition fact: the critical advisory applies to the imported version." },
    };
    findings.push({ ...base, fixPrompt: fixPrompt(base) });
  }
  return findings;
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
