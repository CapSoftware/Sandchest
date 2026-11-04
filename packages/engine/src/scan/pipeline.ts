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
import { CandidateRegistry, checkEvidence, fingerprint, type GatedCandidate } from "./gate";
import { consolidateFindings, type MergedFinding } from "./consolidate";
import { isFatal, errorMessage } from "./errors";
import { capChanges, changedLines, changeTool, relevantChanges, touchesChange, type ChangedFile } from "./changes";
import { planAssignments, planCoverage, planPrAssignments, runHunter, type Assignment, type HunterLimits, type HunterStats } from "./hunt";
import { buildLeads, codeSignals, dependencyFindings, persistentLeads, vulnerabilities, type Signals } from "./leads";
import { Limiter, UsageMeter, type Pricing, type RoleUsage } from "./metrics";
import type { OsvClient } from "./osv";
import { DEPENDENCY_CHECKS, renderAuthModel, renderHistoryForHunt, renderHistoryForSkeptic, renderThreatModel } from "./prompts";
import { recon, type Overview } from "./recon";
import { investigateAuthModel } from "./investigate";
import { severityRank, type Candidate, type Finding, type Lead, type RepoHistory, type ThreatModel } from "./schema";
import { review, unreviewed, type Review } from "./skeptic";
import { structure } from "./structure";
import { createWrap, repoTools, type RouteInfo } from "./tools";
import type { Runtime } from "./runtime";
import { validateFindings, type ValidateOptions } from "./validate";
import { proveFindings } from "./prove";
import { isFixtureFile } from "./paths";
import { trustRank, trustTier } from "./trust";
import { authzConsistencyLeads, authzScoreLeads } from "./consistency";
import { classifyEntryPoints, mergeRecovered } from "./classify";
import type { Classifier } from "../llm/classifier";

export interface ScanOptions {
  client: LlmClient;
  indexer: IndexerClient;
  /** Vulnerability lookups for dependencies. Omit to skip them. */
  osv?: OsvClient;
  /** Reuse a threat model from an earlier scan instead of running recon. */
  threatModel?: ThreatModel;
  /** Review a pull request: only these files, and only findings that touch them. */
  pullRequest?: { files: ChangedFile[] };
  limits?: Partial<ScanLimits>;
  pricing?: Pricing;
  onEvent?: (event: ScanEvent) => void;
  signal?: AbortSignal;
  /**
   * Opt-in dynamic validation: boot the app in the workspace and reproduce
   * surviving findings. Both must be present or the stage is skipped, so the
   * default pipeline is unchanged. It only ever adds a `verified` badge.
   */
  runtime?: Runtime;
  validate?: ValidateOptions;
  /**
   * Optional typed-decision classifier. When present, deep scans recover
   * handlers the indexer's framework-specific route rules missed and score each
   * handler's authorization, so recon, the reachability proof and the
   * peer-consistency check work on frameworks the route detector cannot see.
   * Absent: the stage is skipped and the scan runs on deterministic facts only.
   */
  classifier?: Classifier;
  /**
   * The team's verdicts on this repository's earlier findings. Real ones point hunters at
   * variants; false-positive verdicts ground the skeptic. Omit for a first scan.
   */
  history?: RepoHistory;
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
  /** Findings folded into another that reports the same issue (see `consolidate.ts`). Absent in older reports. */
  merged?: MergedFinding[];
  stats: {
    candidates: number;
    rejectedByGate: number;
    duplicates: number;
    survivors: number;
    /** Survivors whose attacker-reachable path the index confirmed (code-path proof). */
    pathConfirmed: number;
    /** Survivors reproduced against a running instance (runtime validation). */
    verified: number;
    hunters: HunterStats[];
    /** Distinct files agents read. */
    filesRead: number;
  };
  timings: { indexMs: number; sweepMs: number; reconMs: number; huntMs: number; coverageMs: number; verifyTailMs: number; validateMs: number; totalMs: number };
  /** PR reviews: what was reviewed. `changedLines` counts security-relevant lines only. */
  review?: { files: number; changedLines: number; reviewedFiles: string[]; skippedFiles: string[] };
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
  const [overview, routesResult] = await Promise.all([
    indexer.call<Overview>("overview", {}, signal),
    indexer.call<{ routes: RouteInfo[] }>("routes", { limit: 1000 }, signal),
  ]);
  let routes = routesResult.routes;
  if (overview.loc > limits.maxLoc) {
    throw new ScanRefusedError(`This repository has ${overview.loc.toLocaleString("en")} lines of code; the limit is ${limits.maxLoc.toLocaleString("en")}.`);
  }
  emit({ type: "progress", message: `Indexed ${overview.sourceFiles} files and mapped ${overview.routes} entry points.` });

  emit({ type: "stage", stage: "sweep", message: "Sweeping for secrets, vulnerable dependencies and dangerous sinks…" });
  const sweepStarted = Date.now();
  const code = await codeSignals(indexer, signal);
  const signals: Signals = { leads: buildLeads(code, []), vulns: [] };

  // PR reviews look only at security-relevant changed files, riskiest first past the line cap.
  let change: ChangedFile[] | undefined;
  let reviewed: ScanReport["review"];
  if (options.pullRequest) {
    const relevant = relevantChanges(options.pullRequest.files);
    const { kept, dropped } = capChanges(relevant, limits.prLineCap, riskByFile(routes, code.found.sinks));
    change = kept;
    reviewed = { files: relevant.length, changedLines: changedLines(relevant), reviewedFiles: kept.map((f) => f.path), skippedFiles: dropped.map((f) => f.path) };
    if (dropped.length > 0) emit({ type: "progress", message: `Large change: reviewing the ${kept.length} riskiest of ${relevant.length} files.` });
    if (kept.length === 0) {
      emit({ type: "stage", stage: "done", message: "No security-relevant changes to review." });
      return emptyReport(started, overview, options.threatModel, reviewed, Date.now() - started);
    }
  }
  // Deep scans with a classifier: recover handlers the indexer's route rules missed and score each
  // handler's authorization, so recon/proof/consistency work on frameworks the route detector can't
  // see. Best-effort — a classifier failure leaves the deterministic facts untouched. PR reviews skip it.
  let classifiedHandlers: Array<{ name: string; at: string; authz: number; authLevel?: string }> = [];
  if (!change && options.classifier) {
    const recovery = await classifyEntryPoints(indexer, options.classifier, routes, {
      signal,
      onProgress: (message) => emit({ type: "progress", message }),
    }).catch((error) => {
      emit({ type: "warning", message: `Entry-point classification failed: ${errorMessage(error)}` });
      return null;
    });
    if (recovery) {
      classifiedHandlers = recovery.handlers;
      const { candidates, classified, failures, refusals } = recovery.stats;
      routes = mergeRecovered(routes, recovery.recovered);
      if (candidates > 0) {
        emit({
          type: "progress",
          message: `Classified ${classified} definitions; recovered ${recovery.recovered.length} entry point${recovery.recovered.length === 1 ? "" : "s"} the route rules missed.`,
        });
      }
      // Individual failures are isolated so they never sink the scan — but if most calls fail the
      // classifier is misconfigured or down, and that must be visible rather than look like "nothing found".
      const lost = failures + refusals;
      if (lost > 0 && lost >= classified) {
        emit({ type: "warning", message: `Entry-point classifier failed on ${lost} of ${lost + classified} calls; check LLM_CLASSIFIER_* configuration.` });
      }
    }
  }

  // Find handlers that skip an authorization check their peers apply (RoleCast-style), deterministically,
  // while recon runs. These leads make the hardest, most variance-prone class reliably covered instead of
  // found on a lucky hunt. Two detectors, unioned by location: the call-graph+token guard check (works with
  // no classifier) and, when the classifier scored handlers, the language-agnostic authz-score check (sees
  // decorators and unfamiliar frameworks the token list cannot). PR reviews skip both.
  let authzN = 0;
  const nextLeadId = () => `MC${++authzN}`;
  const authzLeads: Promise<Lead[]> = change
    ? Promise.resolve([])
    : authzConsistencyLeads(indexer, routes, nextLeadId, signal)
        .catch(() => [] as Lead[])
        .then((tokenLeads) => {
          const scoreLeads = authzScoreLeads(classifiedHandlers, nextLeadId);
          const byLocation = new Map<string, Lead>();
          for (const lead of [...tokenLeads, ...scoreLeads]) if (lead.at && !byLocation.has(lead.at)) byLocation.set(lead.at, lead);
          return [...byLocation.values()];
        });

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
    tools: [...repoTools({ indexer, wrap, signals, onRead: (path) => read.add(path) }), ...(change ? [changeTool(change, wrap)] : [])],
    limiter: new Limiter(limits.concurrency),
    meter: new UsageMeter(),
    options: limits,
    signal,
    deadline: at(1),
    tag,
    wrap,
    counters: { rejected: 0, duplicates: 0 },
    change,
    emit,
  };

  emit({ type: "stage", stage: "recon", message: "Mapping the attack surface…" });
  const [threatModel, reconMs] = options.threatModel
    ? [options.threatModel, 0]
    : await time(() => recon(base, overview, routes, signals.leads));
  const sweepMs = await advisories;
  // Merge the deterministic authorization-consistency leads (after advisories, which rebuilds signals.leads).
  const authz = await authzLeads;
  if (authz.length > 0) {
    signals.leads = [...signals.leads, ...authz];
    emit({ type: "progress", message: `Flagged ${authz.length} handler${authz.length === 1 ? "" : "s"} that skip an authorization check their peers apply.` });
  }
  const threatModelText = renderThreatModel(threatModel, wrap);
  // Deep scans: investigate how this app enforces authorization (any framework, from the code) to
  // ground access-control reviews. Run it CONCURRENTLY with the hunt — only the skeptic needs it, and
  // reviews start later as candidates stream — so it is off the critical path. PR reviews skip it.
  if (!change && !signal.aborted) emit({ type: "stage", stage: "recon", message: "Working out how authorization is enforced…" });
  const authModelPromise: Promise<string | undefined> =
    change || signal.aborted
      ? Promise.resolve(undefined)
      : investigateAuthModel({ ...base, threatModelText })
          .then((model) => (model ? renderAuthModel(model, wrap) : undefined))
          .catch(() => undefined);
  const ctx: ScanContext = {
    ...base,
    threatModelText,
    historyHuntText: renderHistoryForHunt(options.history, wrap),
    historySkepticText: renderHistoryForSkeptic(options.history, wrap),
  };

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
        // Ground the review in the auth model once it is ready (usually finished during hunting).
        if (ctx.authModelText === undefined) ctx.authModelText = await authModelPromise;
        ruling = await review(ctx, gated, at(0.95));
      } catch (error) {
        ruling = unreviewed(gated, `Review failed (${contain(error, `Review of ${gated.id} failed`)})`);
        if (fatal) return;
      }
    }
    if (ruling.verdict.verdict !== "confirmed") {
      dismissed.push({
        id: gated.id,
        title: gated.candidate.title,
        category: gated.candidate.category,
        at: `${gated.path.at(-1)!.file}:${gated.path.at(-1)!.line}`,
        reasoning: ruling.verdict.reasoning,
        disproof: ruling.verdict.disproof.map((d) => `${d.file}:${d.line} — ${d.explanation}`),
      });
      emit({ type: "progress", message: `Ruled out ${gated.id}${ruling.verdict.verdict === "not_a_vulnerability" ? " (no attacker can use it)" : ""}: ${gated.candidate.title}.` });
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

  const inChange = (at: string | undefined) => !change || (!!at && change.some((f) => at.startsWith(`${f.path}:`)));
  const assignments = change
    ? planPrAssignments(change, routes, signals.leads.filter((lead) => inChange(lead.at)), limits.prMaxHunters, wrap)
    : planAssignments(threatModel, routes, signals.leads, limits.maxHunters, wrap);
  emit({ type: "stage", stage: "hunt", message: `Hunting across ${assignments.length} areas: ${assignments.map((a) => a.name).join(", ")}.` });
  const [hunters, huntMs] = await time(() => hunt(assignments, { turns: limits.hunterTurns, turnsPerFinding: limits.turnsPerFinding, maxTurns: limits.hunterMaxTurns, deadline: at(0.55) }));

  let coverageMs = 0;
  const gaps =
    fatal || Date.now() >= at(0.6)
      ? []
      : change
        ? planCoverage([], signals.leads.filter((lead) => lead.kind === "sink" && lead.at && touchesChange(change!, [locationOf(lead.at)])), read, registry.cited(), wrap).slice(0, 1)
        : planCoverage(routes, signals.leads, read, registry.cited(), wrap);
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

  let validateMs = 0;
  if (findings.length > 0 && !signal.aborted) {
    emit({ type: "stage", stage: "verify", message: "Proving the code path of what we found…" });
    [, validateMs] = await time(async () => {
      try {
        // Always-on: prove each finding's path through the index, no app boot.
        await proveFindings(indexer, findings, { routes, signal, onProgress: (message) => emit({ type: "progress", message }) });
        // Stronger tier, when a runtime is supplied: reproduce live, upgrading to `verified`.
        if (options.runtime && options.validate) {
          await validateFindings(options.runtime, findings, {
            ...options.validate,
            signal,
            onProgress: (message) => emit({ type: "progress", message }),
          });
        }
      } catch (error) {
        // Validation is best-effort: a failure here must never fail the scan or lose a finding.
        if (isFatal(error, signal)) throw error;
        emit({ type: "warning", message: `Validation did not finish: ${errorMessage(error)}` });
      }
    });
  }

  // Deep scans: every critical advisory in an imported dependency is considered every run (killing hunter
  // variance), and shown only if the skeptic finds the app exposed to it. PR reviews skip this: their
  // findings must touch the change.
  if (!change) {
    const deps = dependencyFindings(signals.vulns, findings);
    if (deps.length) emit({ type: "progress", message: `Checking whether ${deps.length} known-vulnerable ${deps.length === 1 ? "dependency is" : "dependencies are"} exploitable here…` });
    const rulings = await Promise.all(
      deps.map(async (finding, i) => {
        const gated = dependencyCandidate(finding, `D${i + 1}`);
        try {
          return { finding, gated, ruling: await review(ctx, gated, at(0.95)) };
        } catch (error) {
          return { finding, gated, ruling: unreviewed(gated, `Review failed (${contain(error, `Review of ${gated.id} failed`)})`) };
        }
      }),
    );
    // Set by a review that hit a fatal error (the closures above assign it).
    const stopped = fatal as { error: unknown } | undefined;
    if (stopped) throw stopped.error;
    for (const { finding, gated, ruling } of rulings) {
      const { verdict } = ruling;
      if (verdict.verdict !== "confirmed") {
        dismissed.push({ id: gated.id, title: finding.title, category: finding.category, at: `${finding.entryPoint.file}:${finding.entryPoint.line}`, reasoning: verdict.reasoning, disproof: verdict.disproof.map((d) => `${d.file}:${d.line} — ${d.explanation}`) });
        continue;
      }
      const kept: Finding = { ...finding, severity: verdict.severity, confidence: verdict.confidence, skeptic: { confidence: verdict.confidence, reasoning: verdict.reasoning } };
      findings.push(kept);
      emit({ type: "finding", finding: kept });
    }
  }

  // One issue reported from two angles (different lines, different category) is merged into one finding.
  let merged: MergedFinding[] = [];
  if (findings.length > 1 && !signal.aborted) {
    emit({ type: "stage", stage: "verify", message: "Merging repeat reports of the same issue…" });
    const result = await consolidateFindings({ client: ctx.client, findings, wrap: ctx.wrap, signal, deadline: at(1), run: (task) => ctx.limiter.run(task, "urgent") });
    if (result.usage) ctx.meter.add("skeptic", result.usage.usage, result.usage.attempts, result.usage.retries);
    if (result.merged.length) emit({ type: "progress", message: `Merged ${result.merged.length} repeat report${result.merged.length === 1 ? "" : "s"} into the findings they repeat.` });
    findings.splice(0, findings.length, ...result.findings);
    merged = result.merged;
  }

  // Code that doesn't ship (tests, fixtures, examples) isn't reachable by an attacker: still reported, hidden by default.
  for (const finding of findings) {
    if (!isFixtureFile(finding.entryPoint.file) || !finding.attackPath.every((step) => isFixtureFile(step.file))) continue;
    finding.confidence = "low";
    finding.mitigations = [finding.mitigations, "Every cited line is in test, fixture or example code, which doesn't ship."].filter(Boolean).join(" ");
  }
  // Trust is set from the evidence each finding now carries (validation, origin).
  for (const finding of findings) finding.trust = trustTier(finding);
  // Attribute each finding to the signals that raised it, so outcomes can be traced back to them.
  const leadKinds = new Map(signals.leads.map((lead) => [lead.id, lead.kind] as const));
  for (const finding of findings) {
    const kinds = [...new Set(finding.leads.map((id) => leadKinds.get(id)).filter((kind): kind is Lead["kind"] => !!kind))];
    // Deterministic findings (dependency advisories) set their own source; everything else an agent raised.
    finding.sources = kinds.length > 0 ? kinds : (finding.sources ?? ["hunter"]);
  }
  // Most severe first, then best-corroborated, then most confident: proven findings surface above lone judgments.
  findings.sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || trustRank(a.trust) - trustRank(b.trust) || confidenceRank(a) - confidenceRank(b),
  );
  const leads = persistentLeads(signals.leads).filter((lead) => !change || inChange(lead.at));
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
    merged,
    stats: {
      candidates: registry.size,
      rejectedByGate: base.counters.rejected,
      duplicates: base.counters.duplicates,
      survivors: findings.length,
      pathConfirmed: findings.filter((f) => f.validation?.status === "path_confirmed").length,
      verified: findings.filter((f) => f.validation?.status === "verified").length,
      hunters,
      filesRead: read.size,
    },
    timings: { indexMs: overview.indexMs, sweepMs, reconMs, huntMs, coverageMs, verifyTailMs, validateMs, totalMs },
    usage: { byRole: meter.byRole, total: meter.total(), costUsd: options.pricing ? meter.cost(options.pricing) : undefined },
    warnings,
    review: reviewed,
  };
}

export interface ReconResult {
  threatModel: ThreatModel;
  loc: number;
  durationMs: number;
  usage: RoleUsage;
  costUsd?: number;
}

/** Builds the repo's threat model alone: the first scan after install, and refreshes. */
export async function runRecon(options: Omit<ScanOptions, "threatModel" | "pullRequest">): Promise<ReconResult> {
  const started = Date.now();
  const limits: ScanLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const { indexer, signal } = options;
  const emit = (event: ScanEvent) => options.onEvent?.(event);
  emit({ type: "stage", stage: "index", message: "Indexing the code…" });
  const [overview, { routes }, code] = await Promise.all([
    indexer.call<Overview>("overview", {}, signal),
    indexer.call<{ routes: RouteInfo[] }>("routes", { limit: 1000 }, signal),
    codeSignals(indexer, signal),
  ]);
  if (overview.loc > limits.maxLoc) {
    throw new ScanRefusedError(`This repository has ${overview.loc.toLocaleString("en")} lines of code; the limit is ${limits.maxLoc.toLocaleString("en")}.`);
  }
  const signals: Signals = { leads: buildLeads(code, []), vulns: [] };
  const tag = `repo-data-${randomBytes(6).toString("hex")}`;
  const wrap = createWrap(tag);
  const meter = new UsageMeter();
  emit({ type: "stage", stage: "recon", message: "Mapping the attack surface…" });
  const threatModel = await recon(
    {
      client: options.client,
      indexer,
      tools: repoTools({ indexer, wrap, signals }),
      limiter: new Limiter(limits.concurrency),
      meter,
      options: limits,
      signal,
      deadline: started + limits.timeBudgetMs,
      tag,
      wrap,
      counters: { rejected: 0, duplicates: 0 },
      emit,
    },
    overview,
    routes,
    signals.leads,
  );
  emit({ type: "stage", stage: "done", message: `Mapped ${overview.routes} entry points and ${threatModel.subsystems.length} areas to scan.` });
  return { threatModel, loc: overview.loc, durationMs: Date.now() - started, usage: meter.total(), costUsd: options.pricing ? meter.cost(options.pricing) : undefined };
}

/** A PR with nothing to review: no model calls at all. */
function emptyReport(started: number, overview: Overview, threatModel: ThreatModel | undefined, review: ScanReport["review"], totalMs: number): ScanReport {
  const none: RoleUsage = { requests: 0, retries: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  return {
    version: 1,
    startedAt: new Date(started).toISOString(),
    durationMs: totalMs,
    repo: { files: overview.sourceFiles, loc: overview.loc, languages: overview.languages },
    threatModel: threatModel ?? EMPTY_THREAT_MODEL,
    leads: [],
    findings: [],
    dismissed: [],
    stats: { candidates: 0, rejectedByGate: 0, duplicates: 0, survivors: 0, pathConfirmed: 0, verified: 0, hunters: [], filesRead: 0 },
    timings: { indexMs: overview.indexMs, sweepMs: 0, reconMs: 0, huntMs: 0, coverageMs: 0, verifyTailMs: 0, validateMs: 0, totalMs },
    usage: { byRole: {}, total: none, costUsd: 0 },
    warnings: [],
    review,
  };
}

const EMPTY_THREAT_MODEL: ThreatModel = {
  summary: "",
  stack: [],
  entryPoints: [],
  authModel: "",
  trustBoundaries: [],
  sensitiveAssets: [],
  dangerousSinks: [],
  frameworkProtections: [],
  abuseSurfaces: [],
  subsystems: [],
};

/** Entry points and sinks per file: how risky a changed file is. */
function riskByFile(routes: RouteInfo[], sinks: Array<{ at: string }>): (path: string) => number {
  const counts = new Map<string, number>();
  for (const { at } of [...routes, ...sinks]) {
    const file = locationOf(at).file;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return (path) => counts.get(path) ?? 0;
}

function locationOf(at: string): { file: string; line: number } {
  const colon = at.lastIndexOf(":");
  return { file: at.slice(0, colon), line: Number(at.slice(colon + 1)) };
}

export interface VerifyOptions {
  client: LlmClient;
  indexer: IndexerClient;
  threatModel: ThreatModel;
  /** Findings from an earlier scan, or candidates in their own shape. */
  findings: Array<Finding | Candidate>;
  limits?: Partial<ScanLimits>;
  pricing?: Pricing;
  signal?: AbortSignal;
  /** Investigate the app's authorization model first and ground the skeptic in it (as a deep scan does). */
  investigateAuth?: boolean;
}

export interface Verification {
  candidate: Candidate;
  /** Why the evidence gate rejected it (its cited lines no longer exist), if it did. */
  rejected?: string[];
  review?: Review;
  error?: string;
}

/**
 * Re-runs the evidence gate and the skeptic on findings against a checkout:
 * for checking whether a finding still holds on a later commit, and for
 * measuring the skeptic against labelled findings.
 */
export async function verifyFindings(options: VerifyOptions): Promise<{ results: Verification[]; usage: RoleUsage; costUsd?: number }> {
  const limits: ScanLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const tag = `repo-data-${randomBytes(6).toString("hex")}`;
  const wrap = createWrap(tag);
  const signal = options.signal;
  const ctx: ScanContext = {
    client: options.client,
    indexer: options.indexer,
    tools: repoTools({ indexer: options.indexer, wrap, signals: { leads: [], vulns: [] } }),
    limiter: new Limiter(limits.concurrency),
    meter: new UsageMeter(),
    options: limits,
    signal,
    deadline: Date.now() + limits.timeBudgetMs,
    tag,
    wrap,
    counters: { rejected: 0, duplicates: 0 },
    emit: () => {},
    threatModelText: renderThreatModel(options.threatModel, wrap),
  };
  if (options.investigateAuth) {
    const authModel = await investigateAuthModel(ctx);
    if (authModel) ctx.authModelText = renderAuthModel(authModel, wrap);
  }

  const results = await Promise.all(
    options.findings.map(async (input, i): Promise<Verification> => {
      // A dependency advisory matched by version is reviewed as the scan reviews it, with the dependency checks.
      const candidate = isSweptDependency(input) ? dependencyCandidate(input, `C${i + 1}`).candidate : toCandidate(input);
      try {
        const gate = await checkEvidence(ctx.indexer, candidate, signal);
        if (!gate.ok) return { candidate, rejected: gate.problems };
        const gated: GatedCandidate = {
          id: `C${i + 1}`,
          candidate,
          entry: gate.entry,
          path: gate.path,
          fingerprint: fingerprint(candidate.category, gate.path.at(-1)!),
          hunter: "verify",
        };
        return { candidate, review: await review(ctx, gated) };
      } catch (error) {
        if (isFatal(error, signal)) throw error;
        return { candidate, error: errorMessage(error) };
      }
    }),
  );
  return { results, usage: ctx.meter.total(), costUsd: options.pricing ? ctx.meter.cost(options.pricing) : undefined };
}

/** A finding the dependency sweep made from a version match alone (not one a hunter reported). */
function isSweptDependency(input: Finding | Candidate): input is Finding {
  return "sources" in input && input.sources?.length === 1 && input.sources[0] === "vulnerable_dependency";
}

/** A dependency finding as a candidate for the skeptic, cited at its import site. */
function dependencyCandidate(finding: Finding, id: string): GatedCandidate {
  const at = { file: finding.entryPoint.file, line: finding.entryPoint.line, text: "", symbol: null };
  const candidate: Candidate = {
    ...toCandidate(finding),
    preconditions: { attacker: finding.attacker, trigger: DEPENDENCY_CHECKS, details: finding.preconditions },
  };
  return { id, candidate, entry: at, path: [at], fingerprint: finding.fingerprint, hunter: "dependency sweep" };
}

/** A finding back into the shape hunters report. */
function toCandidate(input: Finding | Candidate): Candidate {
  if (!("attackPath" in input)) return input;
  return {
    title: input.title,
    category: input.category,
    severity: input.severity,
    entryPoint: input.entryPoint,
    path: input.attackPath.map(({ file, line, note }) => ({ file, line, note })),
    // Findings stored before the trigger was asked for: the reviewer judges it from the proof of concept.
    preconditions: { attacker: input.attacker, trigger: "Not recorded; judge it from the proof of concept.", details: input.preconditions },
    proofOfConcept: input.proofOfConcept,
    impact: input.impact,
    leads: input.leads,
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
  return `Found ${findings.length} ${findings.length === 1 ? "finding" : "findings"}: ${counts.join(", ")}.`;
}
