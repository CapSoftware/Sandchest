/**
 * The last stage of the slice engine: the sandbox agent's verdicts become findings. Each `real` verdict is
 * turned into the existing engine's candidate and review, put through the same evidence gate, written up by the
 * same `structure` stage and merged by the same `consolidateFindings`, so the findings it returns have the shape
 * every reader of a scan already expects.
 *
 * Verdict and hunt text was written by agents that read an untrusted repository. It only ever reaches a model
 * inside the scan's untrusted-data delimiters, and the delimiters are taken out again before a finding is
 * returned.
 */
import { randomBytes } from "node:crypto";
import type { IndexerClient } from "../../indexer/client";
import type { LlmClient } from "../../llm";
import { consolidateFindings, type MergedFinding } from "../consolidate";
import { DEFAULT_LIMITS, type ScanContext, type ScanEvent } from "../context";
import { isFatal } from "../errors";
import { fixPrompt } from "../fix-prompt";
import { CandidateRegistry, checkEvidence, fingerprint, normalizePath, type GatedCandidate } from "../gate";
import { Limiter, stageClients, UsageMeter, type Pricing, type UsageSink } from "../metrics";
import { CATEGORIES, type Attacker, type Candidate as ScanCandidate, type Category, type Confidence, type Finding, type Severity } from "../schema";
import type { Review } from "../skeptic";
import { structure } from "../structure";
import { createWrap, type Wrap } from "../tools";
import { AGENT_PATHS, correctionText, type ConfirmedEntry, type FindingsEntry, type Verdict } from "./briefs";
import { normKind, type Candidate } from "./candidates";

/**
 * This engine does not rate severity or confidence. Every finding starts at these, and `structure` may rate the
 * severity again from the code it reads.
 */
export const SLICE_SEVERITY: Severity = "medium";
export const SLICE_CONFIDENCE: Confidence = "medium";

export interface WriteUpOptions {
  client: LlmClient;
  indexer: IndexerClient;
  /** The hunt's result: `findings[i]` describes `candidates[i]`, in rank order. */
  findings: FindingsEntry[];
  candidates: Candidate[];
  /** The refuter session's verdicts, keyed by the hunt ids. */
  verdicts: Verdict[];
  /** The variants session: its verdicts, and the confirmed findings it was given (ids are hunt ids, see `confirmedEntries`). */
  variants?: { verdicts: Verdict[]; confirmed: ConfirmedEntry[] };
  /** The checkout path the agent saw, taken off the front of the locations it wrote. `AGENT_PATHS.app` is always taken off. */
  checkoutRoot?: string;
  signal?: AbortSignal;
  /** When write-ups and merging stop (epoch ms): a write-up still running is dropped, merging is skipped. */
  deadline?: number;
  /** Model calls at once. Default `DEFAULT_LIMITS.concurrency`. */
  concurrency?: number;
  onUsage?: UsageSink;
  pricing?: Pricing;
  requireCost?: boolean;
  /** `finding` once per written-up finding, plus the warnings and progress `structure` and merging emit. */
  onEvent?: (event: ScanEvent) => void;
}

export interface WriteUpCounts {
  /** Refuter rulings by verdict, the last ruling per id winning. */
  real: number;
  false: number;
  unsure: number;
  /** Refuter rulings whose id matches no hunt entry. */
  unknown: number;
  /** Real variant rulings that repeat a confirmed finding. */
  variants: number;
  /** Variant rulings that are not `real`. */
  variantsNotReal: number;
  /** Variant rulings that name no confirmed finding. */
  variantsUnknown: number;
  /** Findings written up, before merging. */
  written: number;
  dropped: number;
  /** Findings folded into another by consolidation. */
  merged: number;
}

export interface WriteUpResult {
  /** Hunt rank order, each finding's variants after it. */
  findings: Finding[];
  counts: WriteUpCounts;
  /** Candidates that came to nothing, with a short machine reason. */
  dropped: Array<{ id: string; reason: DropReason }>;
  /** What consolidation folded in, kept for auditing as a scan report keeps it. */
  merged: MergedFinding[];
}

export type DropReason = "invalid_location" | "evidence_gate" | "gate_error" | "duplicate" | "write_up_failed";

/** Slice kind families onto the existing categories, for kinds that do not name a category themselves. */
export const KIND_CATEGORY: Record<ReturnType<typeof normKind>, Category> = {
  sqli: "sql_injection",
  ssrf: "ssrf",
  xss: "xss",
  authz: "broken_access_control",
};

/** A hunt kind as a category: the category it names (`path traversal`, `open_redirect`), else its family's. */
export function categoryOf(kind: string): Category {
  const named = kind.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (named !== "other" && (CATEGORIES as readonly string[]).includes(named)) return named as Category;
  return KIND_CATEGORY[normKind(kind)];
}

const HUNT_ATTACKERS: Record<string, Attacker> = { u: "unauthenticated", a: "any_user", m: "insider", admin: "admin" };

/** The agent's least-privileged caller in words as an attacker class; undefined when it names none. */
export function attackerOf(text: string): Attacker | undefined {
  const t = text.toLowerCase();
  if (!t.trim() || /^\s*none\b/.test(t)) return undefined;
  if (/any (signed|logged)[- ]in|signed[- ]in user|logged[- ]in user|authenticated user|any (registered |ordinary )?user|any account/.test(t)) return "any_user";
  if (/anon|unauth|not signed|signed out|logged out|no account|outsider|public|anyone|unauthenticated/.test(t)) return "unauthenticated";
  if (/member|manager|moderator|viewer|editor|role|delegated|scoped|insider|employee|staff|former/.test(t)) return "insider";
  if (/admin|owner|operator/.test(t)) return "admin";
  return undefined;
}

/**
 * The confirmed findings to hand the variants session, with hunt ids, so its `variant_of` names a hunt entry.
 * A corrected verdict is described as the weakness the agent confirmed.
 */
export function confirmedEntries(findings: FindingsEntry[], verdicts: Verdict[], options: { checkoutRoot?: string } = {}): ConfirmedEntry[] {
  const ruled = lastRulings(verdicts);
  return findings.flatMap((entry) => {
    const v = ruled.get(entry.id);
    if (v?.verdict !== "real") return [];
    const sink = firstLocation(entry.sink, options.checkoutRoot);
    const at = v.corrected && sink ? (firstLocation(correctionText(v), options.checkoutRoot, sink.file) ?? sink) : sink;
    return [{ id: entry.id, attacker: v.attacker || entry.attacker, location: at ? `${at.file}:${at.line}` : entry.sink, what: v.corrected ? correctionText(v) : v.reason || entry.why }];
  });
}

interface Item {
  candidate: ScanCandidate;
  review: Review;
}

type Built = { item: Item } | { drop: DropReason };

/** Turns the agent's verdicts into findings through the existing gate, write-up and merge stages. */
export async function writeUpVerdicts(options: WriteUpOptions): Promise<WriteUpResult> {
  options.signal?.throwIfAborted();
  const counts: WriteUpCounts = { real: 0, false: 0, unsure: 0, unknown: 0, variants: 0, variantsNotReal: 0, variantsUnknown: 0, written: 0, dropped: 0, merged: 0 };
  const tag = `repo-data-${randomBytes(6).toString("hex")}`;
  const wrap = createWrap(tag);
  const root = options.checkoutRoot;

  // Rulings in hunt rank order, each confirmed finding's variants right after it.
  const ruled = lastRulings(options.verdicts);
  const hunt = new Set(options.findings.map((entry) => entry.id));
  for (const [id, v] of ruled) {
    if (!hunt.has(id)) counts.unknown++;
    else counts[v.verdict]++;
  }
  const confirmed = new Map((options.variants?.confirmed ?? []).map((c) => [c.id, c] as const));
  const variantsOf = new Map<string, Verdict[]>();
  for (const v of lastRulings(options.variants?.verdicts ?? []).values()) {
    const parent = v.variantOf?.trim() ?? "";
    if (!confirmed.has(parent) || !hunt.has(parent) || ruled.get(parent)?.verdict !== "real") counts.variantsUnknown++;
    else if (v.verdict !== "real") counts.variantsNotReal++;
    else {
      counts.variants++;
      variantsOf.set(parent, [...(variantsOf.get(parent) ?? []), v]);
    }
  }

  const built: Array<{ id: string; built: Built }> = [];
  options.findings.forEach((entry, i) => {
    const v = ruled.get(entry.id);
    const slice = options.candidates[i];
    if (v?.verdict !== "real" || !slice) return;
    const parent = fromVerdict(entry, slice, v, wrap, root);
    built.push({ id: entry.id, built: parent });
    for (const variant of variantsOf.get(entry.id) ?? []) {
      built.push({ id: variant.id, built: fromVariant(variant, categoryOf(slice.rows[0]!.kind), confirmed.get(entry.id)!, attackerFor(entry, slice), wrap, root) });
    }
  });

  // One fatal error (cancelled, out of quota, an unpriced call, indexer gone) stops every task at once.
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let fatal: { error: unknown } | undefined;
  // Set by the tasks below; read through this so the check is not narrowed away.
  const stopped = () => fatal;
  const stopIfFatal = (error: unknown): boolean => {
    if (!isFatal(error, signal)) return false;
    fatal ??= { error: options.signal?.aborted ? options.signal.reason : error };
    controller.abort(fatal.error);
    return true;
  };
  // Indexed like `built`: why each one came to nothing, if it did.
  const drops: Array<DropReason | undefined> = built.map(({ built: b }) => ("drop" in b ? b.drop : undefined));

  const clientFor = stageClients(options.client, options.onUsage, options.pricing, { requireCost: options.requireCost });
  const emit = (event: ScanEvent) => options.onEvent?.(event);
  const limiter = new Limiter(options.concurrency ?? DEFAULT_LIMITS.concurrency);
  const meter = new UsageMeter();
  const ctx: ScanContext = {
    client: clientFor("structure"),
    indexer: options.indexer,
    // `structure` reads only the cited code, through the indexer: no tools, and no threat model in its prompt.
    tools: [],
    limiter,
    meter,
    options: DEFAULT_LIMITS,
    signal,
    deadline: options.deadline,
    tag,
    wrap,
    threatModelText: "",
    counters: { rejected: 0, duplicates: 0 },
    emit,
  };

  // The evidence gate, as the old pipeline runs it on every reported candidate.
  const gated = await Promise.all(
    built.map(async ({ id, built: b }, i): Promise<GatedCandidate | undefined> => {
      if (!("item" in b)) return undefined;
      try {
        const gate = await checkEvidence(options.indexer, b.item.candidate, signal);
        if (!gate.ok) return void (drops[i] = "evidence_gate");
        return { id, candidate: b.item.candidate, entry: gate.entry, path: gate.path, fingerprint: fingerprint(b.item.candidate.category, gate.path.at(-1)!), hunter: "slice" };
      } catch (error) {
        if (!stopIfFatal(error)) drops[i] = "gate_error";
        return undefined;
      }
    }),
  );
  if (stopped()) throw stopped()!.error;

  // Repeats are dropped as the hunters' registry drops them (same sink, entry point or path), best-ranked kept.
  const registry = new CandidateRegistry();
  gated.forEach((g, i) => {
    if (!g) return;
    if (registry.find(g.candidate.category, g.entry, g.path, g.fingerprint, g.candidate.leads)) {
      gated[i] = undefined;
      drops[i] = "duplicate";
    } else registry.add(g);
  });

  const written = await Promise.all(
    gated.map(async (g, i): Promise<Finding | undefined> => {
      const b = built[i]!.built;
      if (!g || !("item" in b)) return undefined;
      try {
        // `structure` falls back to the candidate as written when the model fails, and says so in its one
        // warning. A slice candidate has no proof of concept of its own, so that fallback is dropped instead.
        let fellBack = false;
        const own: ScanContext = { ...ctx, emit: (event) => (event.type === "warning" ? (fellBack = true) : emit(event)) };
        const finding = unwrapFinding(await structure(own, g, b.item.review), tag);
        if (fellBack) {
          drops[i] = "write_up_failed";
          return undefined;
        }
        if (!stopped()) emit({ type: "finding", finding });
        return finding;
      } catch (error) {
        if (!stopIfFatal(error)) drops[i] = "write_up_failed";
        return undefined;
      }
    }),
  );
  if (stopped()) throw stopped()!.error;

  let findings = written.filter((f): f is Finding => !!f);
  counts.written = findings.length;
  let merged: MergedFinding[] = [];
  // As the old pipeline merges: one issue reported from two angles becomes one finding.
  if (findings.length > 1 && !signal.aborted) {
    const result = await consolidateFindings({ client: clientFor("consolidate"), findings, wrap, signal, deadline: options.deadline, run: (task) => limiter.run(task, "urgent") });
    if (result.usage) meter.add("skeptic", result.usage.usage, result.usage.attempts, result.usage.retries);
    if (result.merged.length) emit({ type: "progress", message: `Merged ${result.merged.length} repeat report${result.merged.length === 1 ? "" : "s"} into the findings they repeat.` });
    findings = result.findings;
    merged = result.merged;
  }
  options.signal?.throwIfAborted();
  const dropped = built.flatMap(({ id }, i) => (drops[i] ? [{ id, reason: drops[i] }] : []));
  counts.dropped = dropped.length;
  counts.merged = merged.length;
  return { findings, counts, dropped, merged };
}

/** The last ruling for each id, in the order ids first appear. */
function lastRulings(verdicts: Verdict[]): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  for (const v of verdicts) out.set(v.id.trim(), v);
  return out;
}

/** A hunt entry and the agent's `real` ruling as the old engine's candidate and review. */
function fromVerdict(entry: FindingsEntry, slice: Candidate, v: Verdict, wrap: Wrap, root?: string): Built {
  const row = slice.rows[0]!;
  const category = categoryOf(row.kind);
  const at = location(row.file, row.line, root);
  let sink = location(row.sink_file, row.sink_line, root);
  if (!at || !sink) return { drop: "invalid_location" };
  // A corrected ruling is about an adjacent weakness in the same function: describe that one, at the line it cites in that file.
  const claim = v.corrected ? correctionText(v) : row.why || entry.why;
  if (v.corrected) sink = firstLocation(claim, root, sink.file) ?? sink;
  const route = row.title.startsWith(`${row.kind} in `) ? row.title.slice(row.kind.length + 4) : "";
  return {
    item: {
      candidate: candidate({
        category,
        entry: at,
        route,
        sink,
        attacker: attackerOf(v.attacker) ?? attackerFor(entry, slice),
        caller: v.attacker || entry.attacker,
        claim,
        victim: v.victim || row.victim,
        wrap,
      }),
      review: review(v.corrected ? correctionText(v) : v.reason, wrap),
    },
  };
}

/** A real variant ruling as a candidate of its parent's category, cited at the location the agent found. */
function fromVariant(v: Verdict, category: Category, parent: ConfirmedEntry, fallback: Attacker, wrap: Wrap, root?: string): Built {
  const at = firstLocation(v.location ?? "", root);
  if (!at) return { drop: "invalid_location" };
  return {
    item: {
      candidate: candidate({
        category,
        entry: at,
        route: "",
        sink: at,
        attacker: attackerOf(v.attacker) ?? fallback,
        caller: v.attacker,
        claim: v.reason,
        victim: v.victim,
        context: `Same flaw as a confirmed finding: ${parent.what}`,
        wrap,
      }),
      review: review(v.reason, wrap),
    },
  };
}

function attackerFor(entry: FindingsEntry, slice: Candidate): Attacker {
  return HUNT_ATTACKERS[slice.rows[0]!.attacker] ?? attackerOf(entry.attacker) ?? "any_user";
}

interface Parts {
  category: Category;
  entry: { file: string; line: number };
  /** The entry point as the hunt named it (method and path), or empty. */
  route: string;
  sink: { file: string; line: number };
  attacker: Attacker;
  /** The caller in the agent's words. */
  caller: string;
  claim: string;
  victim: string;
  context?: string;
  wrap: Wrap;
}

/**
 * The old engine's candidate. Only the category, the locations and fixed text are written in the clear; whatever
 * an agent wrote goes inside the delimiters, cut to the field's length.
 */
function candidate(p: Parts): ScanCandidate {
  const untrusted = (text: string, max: number, fallback: string) => (text.trim() ? p.wrap(clip(text.trim(), max)) : fallback);
  const sameLine = p.entry.file === p.sink.file && p.entry.line === p.sink.line;
  const sinkNote = untrusted(p.claim, 400, "The weakness the reviewer confirmed.");
  return {
    title: clip(`${label(p.category)} at ${p.sink.file}:${p.sink.line}`, 140),
    category: p.category,
    severity: SLICE_SEVERITY,
    entryPoint: { ...p.entry, description: untrusted(p.route, 200, `${p.entry.file}:${p.entry.line}`) },
    path: sameLine ? [{ ...p.sink, note: sinkNote }] : [{ ...p.entry, note: "Entry point: the handler that receives the request." }, { ...p.sink, note: sinkNote }],
    preconditions: {
      attacker: p.attacker,
      trigger: untrusted(p.caller ? `Reached by ${p.caller}. ${p.claim}` : p.claim, 300, "Calls the entry point with input of their choosing."),
      details: p.context ? untrusted(p.context, 400, "none") : "none",
    },
    proofOfConcept: "Not supplied by the reviewer: build it from the reviewer's notes and the cited code.",
    impact: untrusted(p.victim ? `Harms ${p.victim}` : "", 300, "Harm to another user or tenant, as the reviewer describes."),
    leads: [],
  };
}

function review(reason: string, wrap: Wrap): Review {
  return {
    ruled: true,
    verdict: {
      verdict: "confirmed",
      confidence: SLICE_CONFIDENCE,
      disproof: [],
      severity: SLICE_SEVERITY,
      reasoning: reason.trim() ? wrap(clip(reason.trim(), 2_000)) : "The reviewer confirmed it without notes.",
    },
  };
}

const LABELS: Partial<Record<Category, string>> = { sql_injection: "SQL injection", ssrf: "Server-side request forgery", xss: "Cross-site scripting" };

function label(category: Category): string {
  const words = category.replaceAll("_", " ");
  return LABELS[category] ?? words[0]!.toUpperCase() + words.slice(1);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const LOCATION = /([\w./\-\[\]@()]+):(\d+)/g;

/** A repository-relative path, with the checkout path the agent saw taken off. */
function repoPath(file: string, root?: string): string {
  let out = file.trim();
  for (const prefix of [root, AGENT_PATHS.app]) {
    if (!prefix) continue;
    const base = prefix.replace(/\/+$/, "");
    if (out.startsWith(`${base}/`)) out = out.slice(base.length + 1);
  }
  return normalizePath(out);
}

function location(file: string, line: number, root?: string): { file: string; line: number } | undefined {
  const path = repoPath(file ?? "", root);
  return path && Number.isInteger(line) && line > 0 ? { file: path, line } : undefined;
}

/** The first `file:line` a text cites, in `file` when given. */
function firstLocation(text: string, root?: string, file?: string): { file: string; line: number } | undefined {
  for (const m of text.matchAll(LOCATION)) {
    const at = location(m[1]!, Number(m[2]), root);
    if (at && (file === undefined || at.file === file)) return at;
  }
  return undefined;
}

/** The finding with the delimiters taken out of every text field, and its fix prompt built again from the clean text. */
function unwrapFinding(finding: Finding, tag: string): Finding {
  const strip = (text: string) => text.replaceAll(`<${tag}>\n`, "").replaceAll(`\n</${tag}>`, "").replaceAll(`<${tag}>`, "").replaceAll(`</${tag}>`, "");
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") return strip(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
    return value;
  };
  const out = clean(finding) as Finding;
  return { ...out, fixPrompt: fixPrompt(out) };
}
