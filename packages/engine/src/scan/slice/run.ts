/**
 * The slice hunt end to end: select code, hunt each packet in three passes with reasoning off, cluster what was
 * reported, score each cluster 0-9 three times, dedupe and rank. Returns the top candidates, ready for the
 * verification brief. Model calls go through `stageClients`, so each one is metered like the rest of the engine.
 */
import { posix } from "node:path";
import type { LlmClient, Message, Role } from "../../llm";
import { isFatal } from "../errors";
import { Limiter, stageClients, type Pricing, type UsageSink } from "../metrics";
import { findingsEntry, type FindingsEntry } from "./briefs";
import { planBundle, type Bundle, type BundleMode, type Packet, type PlanDeps } from "./bundle";
import { cluster, dedupe, TOP_BANDS, TOP_K, topK, type Candidate, type Cluster } from "./candidates";
import { changeBundle, changeCandidates, changedServerPaths, changesFromDiff, type ChangedSource, type Range } from "./change";
import { candidateDeviance, type DevDef, type DevianceDeps } from "./deviance";
import { answerText, huntMessages, loadLines, parseHuntReply, type HuntMode, type HuntRow, type LinesOf } from "./hunt";
import { addVotes, parseScoreReply, retryBatches, SCORE_SAMPLES, scoreBatches, scoreMessages, toScoreVotes, type ScoreBatch, type ScoreVotes } from "./score";

export const SLICE_RUN = {
  /** Hunt passes per packet. */
  passes: 3,
  huntMaxTokens: 3_000,
  scoreMaxTokens: 4_000,
  /**
   * A packet's later passes are queued once its first pass has ended, when the packet's code is cached, or
   * after n times this for pass n, whichever comes first.
   */
  passDelayMs: 6_000,
  /**
   * Model calls at once. A packet's later passes still follow its first, so the packet's code is cached for
   * them however wide this is.
   */
  concurrency: 24,
  /** Findings-file titles are cut to this for a code change. */
  changeTitleMax: 100,
};

export interface SliceRunOptions {
  client: LlmClient;
  signal?: AbortSignal;
  /** Model calls at once. Default `SLICE_RUN.concurrency`. */
  concurrency?: number;
  onUsage?: UsageSink;
  pricing?: Pricing;
  /** Every call must report a cost or be priced; one that is not stops the run. */
  requireCost?: boolean;
  onProgress?: (message: string) => void;
  /** Default `SLICE_RUN.passDelayMs`. */
  passDelayMs?: number;
  /** Once per phase when it ends (epoch ms), the phase that failed included. A phase never reached is not reported. */
  onPhase?: (phase: SlicePhase, startedAt: number, endedAt: number, ok: boolean) => void;
}

export type SlicePhase = "select" | "hunt" | "score";

export interface SliceHuntOptions extends SliceRunOptions, PlanDeps {
  /** The most candidates selected. Default `TOP_BANDS` bands of `TOP_K`. */
  top?: number;
}

/** The change as diff text, or already parsed (the same result for the same change). */
export type ChangeHuntOptions = SliceRunOptions & {
  /** File text at the changed commit, or undefined when it cannot be read. */
  readFile: (file: string) => Promise<string | undefined>;
} & (
    | {
        /** `git diff --numstat` of the change. */
        numstat: string;
        /** `git diff -U0` of the change. */
        diff: string;
      }
    | { changes: ChangedSource[] }
  );

export interface SliceHuntCounts {
  packets: number;
  huntCalls: number;
  huntFailed: number;
  scoreCalls: number;
  scoreFailed: number;
  rows: number;
  clusters: number;
  /** Candidates left after dedupe. */
  kept: number;
  selected: number;
}

export interface SliceHuntResult {
  /** The selection, numbered `F1`, `F2`... in rank order; `findings[i]` describes `candidates[i]`. */
  findings: FindingsEntry[];
  candidates: Candidate[];
  bundle: { files: number; lines: number; mode: BundleMode | "change" };
  counts: SliceHuntCounts;
}

/** Whole repository: the bundle plan, hunt x3, score x3, dedupe, the top two bands of 30 by score interleaved with score plus deviance. */
export function runSliceHunt(options: SliceHuntOptions): Promise<SliceHuntResult> {
  const phases = phaseClock(options.onPhase);
  return phases.around(() => sliceHunt(options, phases));
}

async function sliceHunt(options: SliceHuntOptions, phases: PhaseClock): Promise<SliceHuntResult> {
  phases.start("select");
  const listFiles = once(options.listFiles);
  const plan = await planBundle({ indexer: options.indexer, readFile: options.readFile, listFiles });
  options.signal?.throwIfAborted();
  const { bundle } = plan;
  const size = { files: bundleFiles(bundle), lines: bundle.stats.totalLines, mode: plan.mode };
  options.onProgress?.(`Selected ${size.files} files, ${size.lines} lines (${plan.mode})`);

  const found = await huntAndScore(options, bundle, "generic", phases);
  const kept = dedupe(found.clusters, found.scores);
  const deviance = await candidateDeviance(kept, devianceDeps(options, listFiles));
  options.signal?.throwIfAborted();
  const selected = topK(kept, deviance, options.top ?? TOP_BANDS * TOP_K);
  return result(found, kept, selected, size, {});
}

/** A code change: changed server files, the change-review hunt x3, score x3, candidates on changed lines, top 12. */
export function runChangeHunt(options: ChangeHuntOptions): Promise<SliceHuntResult> {
  const phases = phaseClock(options.onPhase);
  return phases.around(() => changeHunt(options, phases));
}

async function changeHunt(options: ChangeHuntOptions, phases: PhaseClock): Promise<SliceHuntResult> {
  phases.start("select");
  const changes = "changes" in options ? options.changes : changesFromDiff(options.numstat, options.diff);
  const files: Array<{ file: string; text: string; hunks: Range[] }> = [];
  for (const change of changes) {
    if (!changedServerPaths([change]).length || !change.ranges.length) continue;
    const text = await options.readFile(change.path).catch(() => undefined);
    if (text !== undefined) files.push({ file: change.path, text, hunks: change.ranges });
  }
  options.signal?.throwIfAborted();
  const change = changeBundle(files);
  const size = { files: bundleFiles(change.bundle), lines: change.bundle.stats.totalLines, mode: "change" as const };
  options.onProgress?.(`Selected ${size.files} changed files, ${size.lines} lines`);

  const found = await huntAndScore(options, change.bundle, "change", phases);
  const { kept, selected } = changeCandidates(found.clusters, found.scores, change.hunks);
  return result(found, kept, selected, size, { titleMax: SLICE_RUN.changeTitleMax });
}

interface PhaseClock {
  /** Ends the phase under way, as ok, and starts this one. */
  start(phase: SlicePhase): void;
  /** Runs the whole hunt: the last phase ends ok with it, or failed with its error. */
  around<T>(run: () => Promise<T>): Promise<T>;
}

/** Times the phases for `onPhase`. A callback that throws is ignored: timing never stops a run. */
function phaseClock(onPhase: SliceRunOptions["onPhase"]): PhaseClock {
  let current: { phase: SlicePhase; startedAt: number } | undefined;
  const end = (ok: boolean) => {
    if (!current) return;
    const { phase, startedAt } = current;
    current = undefined;
    try {
      onPhase?.(phase, startedAt, Date.now(), ok);
    } catch {
      // Timing only.
    }
  };
  return {
    start(phase) {
      end(true);
      current = { phase, startedAt: Date.now() };
    },
    async around(run) {
      try {
        const out = await run();
        end(true);
        return out;
      } catch (error) {
        end(false);
        throw error;
      }
    },
  };
}

interface Found {
  clusters: Cluster[];
  scores: ScoreVotes;
  counts: Omit<SliceHuntCounts, "kept" | "selected">;
}

function result(found: Found, kept: Candidate[], selected: number[], bundle: SliceHuntResult["bundle"], entry: { titleMax?: number }): SliceHuntResult {
  return {
    findings: selected.map((i, position) => findingsEntry(kept[i]!, position, i, entry)),
    candidates: selected.map((i) => kept[i]!),
    bundle,
    counts: { ...found.counts, kept: kept.length, selected: selected.length },
  };
}

/** Hunts every packet, clusters the rows and scores the clusters. */
async function huntAndScore(options: SliceRunOptions & { readFile: (file: string) => Promise<string | undefined> }, bundle: Bundle, mode: HuntMode, phases: PhaseClock): Promise<Found> {
  phases.start("hunt");
  const calls = modelCalls(options);
  const lines = await loadLines(bundle, options.readFile);
  options.signal?.throwIfAborted();

  const packets = bundle.packets.length;
  options.onProgress?.(`Hunting ${packets} packets, ${SLICE_RUN.passes} passes each`);
  const hunt = await huntRows(calls, bundle, lines, mode, options.passDelayMs ?? SLICE_RUN.passDelayMs);
  if (hunt.calls > 0 && hunt.failed === hunt.calls) throw new Error(`Every hunt call failed (${hunt.calls} calls)`);

  const clusters = cluster(hunt.rows);
  phases.start("score");
  let score = { calls: 0, failed: 0, votes: {} as Record<number, string[]> };
  if (clusters.length) {
    options.onProgress?.(`Scoring ${clusters.length} candidates`);
    score = await scoreClusters(calls, bundle, lines, clusters);
    if (score.failed === score.calls) throw new Error(`Every scoring call failed (${score.calls} calls)`);
  }
  return {
    clusters,
    scores: toScoreVotes(score.votes),
    counts: { packets, huntCalls: hunt.calls, huntFailed: hunt.failed, scoreCalls: score.calls, scoreFailed: score.failed, rows: hunt.rows.length, clusters: clusters.length },
  };
}

/**
 * Every pass of every packet. Rows come out pass by pass, packets in bundle order, whatever finishes first.
 * A packet's later passes wait for its first to end (however it ended), or for their delay if that is sooner.
 */
async function huntRows(calls: ModelCalls, bundle: Bundle, lines: LinesOf, mode: HuntMode, delayMs: number) {
  const jobs = Array.from({ length: SLICE_RUN.passes }, (_, pass) => bundle.packets.map((packet) => ({ packet, pass }))).flat();
  // Pass 0 of every packet comes first in `jobs`, so a later pass always finds its packet's first.
  const first = new Map<Packet, Promise<unknown>>();
  const replies = await calls.all(
    jobs.map(({ packet, pass }) => {
      const call = calls.call("slice_hunt", "hunt", huntMessages(packet, bundle.spans, lines, mode, pass), SLICE_RUN.huntMaxTokens, pass === 0 ? undefined : { delayMs: pass * delayMs, until: first.get(packet) });
      if (pass === 0) first.set(packet, call);
      return call;
    }),
  );
  const rows: HuntRow[] = [];
  replies.forEach((text, k) => {
    if (text !== undefined) rows.push(...parseHuntReply(text, jobs[k]!.packet, jobs[k]!.pass));
  });
  return { rows, calls: jobs.length, failed: replies.filter((r) => r === undefined).length };
}

/** Three samples per batch, then one retry in half-size batches for clusters that got no vote. */
async function scoreClusters(calls: ModelCalls, bundle: Bundle, lines: LinesOf, clusters: Cluster[]) {
  const packets = new Map(bundle.packets.map((p) => [p.name, p]));
  const votes: Record<number, string[]> = {};
  let made = 0;
  let failed = 0;
  const round = async (batches: ScoreBatch[], samples: number) => {
    const jobs = batches.flatMap((b) => Array.from({ length: samples }, () => b));
    const replies = await calls.all(jobs.map((b) => calls.call("slice_score", "skeptic", scoreMessages(packets.get(b.packet)!, bundle.spans, lines, clusters, b.ids), SLICE_RUN.scoreMaxTokens)));
    made += jobs.length;
    // Votes are added in job order, so a cluster's votes do not depend on which call finished first.
    for (const text of replies) {
      if (text === undefined) failed++;
      else addVotes(votes, parseScoreReply(text));
    }
  };
  await round(scoreBatches(clusters), SCORE_SAMPLES);
  await round(retryBatches(clusters, votes), 1);
  return { calls: made, failed, votes };
}

interface ModelCalls {
  /**
   * One call's answer text, or undefined when it failed with an ordinary error. With `wait`, the call is queued
   * after `delayMs`, or as soon as `until` settles if that is sooner.
   */
  call(stage: string, role: Role, messages: Message[], maxTokens: number, wait?: { delayMs: number; until?: Promise<unknown> }): Promise<string | undefined>;
  /** Waits for every call; then rethrows the first fatal error, if any. */
  all(calls: Array<Promise<string | undefined>>): Promise<Array<string | undefined>>;
}

/** Limited, metered calls with reasoning off. A fatal error (or the caller's abort) stops every call still to come. */
function modelCalls(options: SliceRunOptions): ModelCalls {
  const clientFor = stageClients(options.client, options.onUsage, options.pricing, { requireCost: options.requireCost });
  const limiter = new Limiter(options.concurrency ?? SLICE_RUN.concurrency);
  const stop = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  let fatal: { error: unknown } | undefined;
  const stopIfFatal = (error: unknown) => {
    if (fatal || !isFatal(error, options.signal)) return;
    fatal = { error: options.signal?.aborted ? options.signal.reason : error };
    stop.abort(fatal.error);
  };

  return {
    async call(stage, role, messages, maxTokens, wait) {
      try {
        if (wait && wait.delayMs > 0) await pause(wait.delayMs, signal, wait.until);
        return await limiter.run(async () => {
          signal.throwIfAborted();
          try {
            const reply = await clientFor(stage).chat({ role, messages, maxTokens, reasoningEffort: null, signal });
            return answerText(reply.content, reply.reasoning);
          } catch (error) {
            // Stop before the slot goes to the next queued call.
            stopIfFatal(error);
            throw error;
          }
        });
      } catch (error) {
        stopIfFatal(error);
        if (fatal) throw fatal.error;
        return undefined;
      }
    },
    async all(calls) {
      const settled = await Promise.allSettled(calls);
      if (fatal) throw fatal.error;
      options.signal?.throwIfAborted();
      return settled.map((s) => (s.status === "fulfilled" ? s.value : undefined));
    },
  };
}

/** Deviance inputs from the plan's own deps: indexer definitions, file text, and the listing for siblings. */
function devianceDeps(options: SliceHuntOptions, listFiles: () => Promise<string[]>): DevianceDeps {
  return {
    definitions: async (file) => (await options.indexer.call<{ definitions: DevDef[] }>("definitions", { path: file, limit: 5000 }, options.signal)).definitions,
    lines: async (file) => (await options.readFile(file))?.split("\n") ?? [],
    listDir: async (dir) => (await listFiles()).filter((f) => posix.dirname(f) === dir).map((f) => posix.basename(f)),
  };
}

/** Distinct files a bundle shows. */
function bundleFiles(bundle: Bundle): number {
  const files = new Set<string>();
  for (const p of bundle.packets) {
    for (const k of p.shared) if (bundle.spans[k]) files.add(bundle.spans[k].file);
    for (const e of p.entries) files.add(e.handler.file);
  }
  return files.size;
}

function once<T>(f: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= f());
}

/** Resolves after `ms`, or when `sooner` settles if that comes first; rejects with the signal's reason when it aborts first. */
function pause(ms: number, signal: AbortSignal, sooner?: Promise<unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    sooner?.then(done, done);
  });
}
