/**
 * A full deep scan against a checkout served by the indexer:
 *
 *   signal sweep → recon → hunt → evidence gate → skeptic → structure → fingerprint
 *
 * Hunters run in parallel. Each candidate goes to the skeptic the moment a
 * hunter reports it, so findings stream out while hunting continues.
 */
import { randomBytes } from "node:crypto";
import type { IndexerClient } from "../indexer/client";
import type { LlmClient } from "../llm";
import { DEFAULT_LIMITS, type ScanContext, type ScanEvent, type ScanLimits } from "./context";
import { CandidateRegistry, type GatedCandidate } from "./gate";
import { planAssignments, runHunter, type HunterStats } from "./hunt";
import { persistentLeads, sweep } from "./leads";
import { Limiter, UsageMeter, type Pricing, type RoleUsage } from "./metrics";
import type { OsvClient } from "./osv";
import { renderThreatModel } from "./prompts";
import { recon, type Overview } from "./recon";
import { severityRank, type Finding, type Lead, type ThreatModel } from "./schema";
import { review } from "./skeptic";
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
  };
  timings: { indexMs: number; sweepMs: number; reconMs: number; huntMs: number; verifyTailMs: number; totalMs: number };
  usage: { byRole: Record<string, RoleUsage>; total: RoleUsage; costUsd?: number };
  warnings: string[];
}

export class ScanRefusedError extends Error {
  override readonly name = "ScanRefusedError";
}

export async function runScan(options: ScanOptions): Promise<ScanReport> {
  const started = Date.now();
  const limits: ScanLimits = { ...DEFAULT_LIMITS, ...options.limits };
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
  const { indexer, signal } = options;

  emit({ type: "stage", stage: "index", message: "Indexing the code…" });
  const overview = await indexer.call<Overview>("overview", {}, signal);
  if (overview.loc > limits.maxLoc) {
    throw new ScanRefusedError(`This repository has ${overview.loc.toLocaleString("en")} lines of code; the limit is ${limits.maxLoc.toLocaleString("en")}.`);
  }
  const { routes } = await indexer.call<{ routes: RouteInfo[] }>("routes", { limit: 1000 }, signal);
  emit({ type: "progress", message: `Indexed ${overview.sourceFiles} files and mapped ${overview.routes} entry points.` });

  emit({ type: "stage", stage: "sweep", message: "Sweeping for secrets, vulnerable dependencies and dangerous sinks…" });
  const [swept, sweepMs] = await time(() => sweep(indexer, options.osv, signal));
  if (swept.osvError) emit({ type: "warning", message: `Dependency vulnerability lookup failed: ${swept.osvError}` });

  const tag = `repo-data-${randomBytes(6).toString("hex")}`;
  const wrap = createWrap(tag);
  const base: Omit<ScanContext, "threatModelText"> = {
    client: options.client,
    indexer,
    tools: repoTools({ indexer, wrap, leads: swept.leads, vulns: swept.vulns }),
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
    : await time(() => recon(base, overview, routes, swept.leads));
  const ctx: ScanContext = { ...base, threatModelText: renderThreatModel(threatModel) };

  const assignments = planAssignments(threatModel, routes, swept.leads, limits.maxHunters, wrap);
  emit({ type: "stage", stage: "hunt", message: `Digging with ${assignments.length} hunters: ${assignments.map((a) => a.name).join(", ")}.` });

  const registry = new CandidateRegistry();
  const findings: Finding[] = [];
  const dismissed: DismissedCandidate[] = [];
  const verifying: Promise<void>[] = [];

  const verify = async (gated: GatedCandidate) => {
    const ruling = await review(ctx, gated);
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

  const [hunters, huntMs] = await time(() =>
    Promise.all(
      assignments.map((assignment) =>
        runHunter(ctx, assignment, registry, (gated) => {
          emit({ type: "progress", message: `${gated.id} reported by the ${gated.hunter} hunter: ${gated.candidate.title}. Verifying…` });
          verifying.push(verify(gated));
        }),
      ),
    ),
  );

  emit({ type: "stage", stage: "verify", message: `Hunting done; ${registry.size} candidates. Finishing verification…` });
  const [, verifyTailMs] = await time(() => Promise.all(verifying));

  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || confidenceRank(a) - confidenceRank(b));
  const leads = persistentLeads(swept.leads);
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
    },
    timings: { indexMs: overview.indexMs, sweepMs, reconMs, huntMs, verifyTailMs, totalMs },
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
