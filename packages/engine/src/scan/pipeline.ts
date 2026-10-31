/**
 * A full deep scan against a checkout served by the indexer:
 *
 *   signal sweep → recon → hunt → evidence gate → skeptic → structure → fingerprint
 *
 * The dependency lookup overlaps recon. Hunters run in parallel, then a
 * coverage pass sends a few more at reachable code nobody opened. Each
 * candidate goes to the skeptic the moment it is reported, so findings
 * stream out while hunting continues.
 *
 * Failures are contained: a hunter or review that fails costs only its own
 * work. Cancellation, quota exhaustion or a dead indexer stop everything.
 */
import { randomBytes } from "node:crypto";
import type { IndexerClient } from "../indexer/client";
import type { LlmClient } from "../llm";
import { DEFAULT_LIMITS, type ScanContext, type ScanEvent, type ScanLimits } from "./context";
import { CandidateRegistry, type GatedCandidate } from "./gate";
import { isFatal, errorMessage } from "./errors";
import { planAssignments, planCoverage, runHunter, type Assignment, type HunterLimits, type HunterStats } from "./hunt";
import { buildLeads, codeSignals, persistentLeads, vulnerabilities, type Signals } from "./leads";
import { Limiter, UsageMeter, type Pricing, type RoleUsage } from "./metrics";
import type { OsvClient } from "./osv";
import { renderThreatModel } from "./prompts";
import { recon, type Overview } from "./recon";
import { severityRank, type Finding, type Lead, type ThreatModel } from "./schema";
import { review, unreviewed, type Review } from "./skeptic";
import { structure } from "./structure";
import { createWrap, repoTools, type RouteInfo } from "./tools";

export interface ScanOptions {
  client: LlmClient;
  indexer: IndexerClient;
  /** Vulnerability lookups for dependencies. Omit to skip them. */
  osv?: OsvClient;
  /** Reuse a threat model from an earlier scan instead of running recon. */
  threatModel?: ThreatModel;
  limits?: Partial<ScanLimits>;
  pricing?: Pricing;
  onEvent?: (event: ScanEvent) => void;
  signal?: AbortSignal;
}

export interface DismissedCandidate {
  id: string;
  title: string;
  category: string;
  at: string;
  reasoning: string;
  disproof: string[];
}

export interface ScanReport {
  version: 1;
  startedAt: string;
  durationMs: number;
  repo: { files: number; loc: number; languages: Overview["languages"] };
  threatModel: ThreatModel;
  /** Deterministic leads that stand regardless of what the agents concluded. */
  leads: Lead[];
  /** Survivors, most severe first. Low-confidence findings are hidden by default in the product. */
  findings: Finding[];
  /** Candidates the skeptic disproved, with the code it cited. */
  dismissed: DismissedCandidate[];
  stats: {
    candidates: number;
    rejectedByGate: number;
    duplicates: number;
    survivors: number;
    hunters: HunterStats[];
    /** Distinct files agents read. */
    filesRead: number;
  };
  timings: { indexMs: number; sweepMs: number; reconMs: number; huntMs: number; coverageMs: number; verifyTailMs: number; totalMs: number };
  usage: { byRole: Record<string, RoleUsage>; total: RoleUsage; costUsd?: number };
  warnings: string[];
}

export class ScanRefusedError extends Error {
  override readonly name = "ScanRefusedError";
}

export async function runScan(options: ScanOptions): Promise<ScanReport> {
  const started = Date.now();
  const limits: ScanLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const at = (share: number) => started + limits.timeBudgetMs * share;
  const warnings: string[] = [];
  const emit = (event: ScanEvent) => {
    if (event.type === "warning") warnings.push(event.message);
    options.onEvent?.(event);
  };
  const time = async <T>(task: () => Promise<T>): Promise<[T, number]> => {
    const t = Date.now();
    const value = await task();
    return [value, Date.now() - t];
  };

  // One fatal error (cancelled, out of quota, indexer gone) stops every agent at once.
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let fatal: { error: unknown } | undefined;
  const contain = (error: unknown, what: string): string => {
    if (isFatal(error, signal)) {
      fatal ??= { error: signal.aborted && !controller.signal.aborted ? signal.reason : error };
      controller.abort(fatal.error);
    } else {
      emit({ type: "warning", message: `${what}: ${errorMessage(error)}` });
    }
    return errorMessage(error);
  };
  const { indexer } = options;

  emit({ type: "stage", stage: "index", message: "Indexing the code…" });
  const [overview, { routes }] = await Promise.all([
    indexer.call<Overview>("overview", {}, signal),
    indexer.call<{ routes: RouteInfo[] }>("routes", { limit: 1000 }, signal),
  ]);
  if (overview.loc > limits.maxLoc) {
    throw new ScanRefusedError(`This repository has ${overview.loc.toLocaleString("en")} lines of code; the limit is ${limits.maxLoc.toLocaleString("en")}.`);
  }
  emit({ type: "progress", message: `Indexed ${overview.sourceFiles} files and mapped ${overview.routes} entry points.` });

  emit({ type: "stage", stage: "sweep", message: "Sweeping for secrets, vulnerable dependencies and dangerous sinks…" });
  const sweepStarted = Date.now();
  const code = await codeSignals(indexer, signal);
  const signals: Signals = { leads: buildLeads(code, []), vulns: [] };
  // The advisory lookup is network-bound: let it run while recon maps the code.
  const advisories = vulnerabilities(options.osv, code.dependencies, signal).then((result) => {
    if (result.error) emit({ type: "warning", message: `Dependency vulnerability lookup failed: ${result.error}` });
    signals.vulns = result.vulns;
    signals.leads = buildLeads(code, result.vulns);
    return Date.now() - sweepStarted;
  }, () => Date.now() - sweepStarted); // Only rejects on cancellation, which the scan reports itself.

  const tag = `repo-data-${randomBytes(6).toString("hex")}`;
  const wrap = createWrap(tag);
  const read = new Set<string>();
  const base: Omit<ScanContext, "threatModelText"> = {
    client: options.client,
    indexer,
    tools: repoTools({ indexer, wrap, signals, onRead: (path) => read.add(path) }),
    limiter: new Limiter(limits.concurrency),
    meter: new UsageMeter(),
    options: limits,
    signal,
    tag,
    wrap,
    counters: { rejected: 0, duplicates: 0 },
    emit,
  };

  emit({ type: "stage", stage: "recon", message: "Mapping the attack surface…" });
  const [threatModel, reconMs] = options.threatModel
    ? [options.threatModel, 0]
    : await time(() => recon(base, overview, routes, signals.leads));
  const sweepMs = await advisories;
  const ctx: ScanContext = { ...base, threatModelText: renderThreatModel(threatModel) };

  const registry = new CandidateRegistry();
  const findings: Finding[] = [];
  const dismissed: DismissedCandidate[] = [];
  const verifying: Promise<void>[] = [];

  const verify = async (gated: GatedCandidate) => {
    let ruling: Review;
    if (Date.now() >= at(0.9)) {
      ruling = unreviewed(gated, "The time budget ran out before review");
    } else {
      try {
        ruling = await review(ctx, gated, at(0.95));
      } catch (error) {
        ruling = unreviewed(gated, `Review failed (${contain(error, `Review of ${gated.id} failed`)})`);
        if (fatal) return;
      }
    }
    if (ruling.verdict.verdict === "disproved") {
      dismissed.push({
        id: gated.id,
        title: gated.candidate.title,
        category: gated.candidate.category,
        at: `${gated.path.at(-1)!.file}:${gated.path.at(-1)!.line}`,
        reasoning: ruling.verdict.reasoning,
        disproof: ruling.verdict.disproof.map((d) => `${d.file}:${d.line} — ${d.explanation}`),
      });
      emit({ type: "progress", message: `Ruled out ${gated.id}: ${gated.candidate.title}.` });
      return;
    }
    const finding = await structure(ctx, gated, ruling);
    findings.push(finding);
    emit({ type: "finding", finding });
  };

  const onCandidate = (gated: GatedCandidate) => {
    emit({ type: "progress", message: `${gated.id} reported by the ${gated.hunter} hunter: ${gated.candidate.title}. Verifying…` });
    // Handled here, at once: a failure must never surface as an unhandled rejection.
    verifying.push(verify(gated).catch((error) => void contain(error, `Could not finish ${gated.id}`)));
  };

  const hunt = (assignments: Assignment[], hunterLimits: HunterLimits) =>
    Promise.all(
      assignments.map((assignment) =>
        runHunter(ctx, assignment, registry, hunterLimits, onCandidate).catch((error): HunterStats => {
          const message = contain(error, `The ${assignment.name} hunter stopped early`);
          return { name: assignment.name, turns: 0, toolCalls: 0, reported: 0, accepted: 0, ms: 0, error: message };
        }),
      ),
    );

  const assignments = planAssignments(threatModel, routes, signals.leads, limits.maxHunters, wrap);
  emit({ type: "stage", stage: "hunt", message: `Digging with ${assignments.length} hunters: ${assignments.map((a) => a.name).join(", ")}.` });
  const [hunters, huntMs] = await time(() => hunt(assignments, { turns: limits.hunterTurns, turnsPerFinding: limits.turnsPerFinding, maxTurns: limits.hunterMaxTurns, deadline: at(0.55) }));

  let coverageMs = 0;
  const gaps = fatal || Date.now() >= at(0.6) ? [] : planCoverage(routes, signals.leads, read, registry.cited(), wrap);
  if (gaps.length > 0) {
    emit({ type: "stage", stage: "coverage", message: `Checking code the first pass never opened with ${gaps.length} more ${gaps.length === 1 ? "hunter" : "hunters"}…` });
    const [extra, ms] = await time(() => hunt(gaps, { turns: limits.coverageTurns, turnsPerFinding: limits.turnsPerFinding, maxTurns: limits.hunterMaxTurns, deadline: at(0.75) }));
    hunters.push(...extra);
    coverageMs = ms;
  }

  emit({ type: "stage", stage: "verify", message: `Hunting done; ${registry.size} candidates. Finishing verification…` });
  // Verification can add more work while it runs; wait until the list stops growing.
  const [, verifyTailMs] = await time(async () => {
    for (let settled = 0; settled < verifying.length; ) {
      const batch = verifying.slice(settled);
      settled = verifying.length;
      await Promise.all(batch);
    }
  });
  if (fatal) throw fatal.error;

  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || confidenceRank(a) - confidenceRank(b));
  const leads = persistentLeads(signals.leads);
  const totalMs = Date.now() - started;
  emit({ type: "stage", stage: "done", message: summary(findings) });

  const meter = base.meter;
  return {
    version: 1,
    startedAt: new Date(started).toISOString(),
    durationMs: totalMs,
    repo: { files: overview.sourceFiles, loc: overview.loc, languages: overview.languages },
    threatModel,
    leads,
    findings,
    dismissed,
    stats: {
      candidates: registry.size,
      rejectedByGate: base.counters.rejected,
      duplicates: base.counters.duplicates,
      survivors: findings.length,
      hunters,
      filesRead: read.size,
    },
    timings: { indexMs: overview.indexMs, sweepMs, reconMs, huntMs, coverageMs, verifyTailMs, totalMs },
    usage: { byRole: meter.byRole, total: meter.total(), costUsd: options.pricing ? meter.cost(options.pricing) : undefined },
    warnings,
  };
}

function confidenceRank(finding: Finding): number {
  return ["high", "medium", "low"].indexOf(finding.confidence);
}

function summary(findings: Finding[]): string {
  if (findings.length === 0) return "Nothing buried here. For now.";
  const counts = (["critical", "high", "medium", "low"] as const)
    .map((severity) => [severity, findings.filter((f) => f.severity === severity).length] as const)
    .filter(([, n]) => n > 0)
    .map(([severity, n]) => `${n} ${severity}`);
  return `Dug up ${findings.length} ${findings.length === 1 ? "finding" : "findings"}: ${counts.join(", ")}.`;
}
