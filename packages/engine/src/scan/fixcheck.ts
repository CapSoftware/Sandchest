/**
 * Fix checks: after a push, re-check open findings whose files changed.
 * Code moves, so each cited line is first re-located by its stored text.
 * A finding is fixed only when the skeptic disproves it on the new code,
 * shown what the push changed. A fix often rewrites the vulnerable line
 * itself, so a finding whose sink line is gone is re-checked from the rest of
 * its path; only one with nothing left to anchor to is stale, never silently
 * closed.
 */
import type { IndexerClient } from "../indexer/client";
import type { LlmClient } from "../llm";
import type { ChangedFile } from "./changes";
import type { ScanLimits } from "./context";
import type { Pricing, RoleUsage, UsageSink } from "./metrics";
import type { OsvClient } from "./osv";
import { verifyFindings } from "./pipeline";
import type { Finding, ThreatModel } from "./schema";
import type { Dependency, ReadResult } from "./tools";

export interface FixCheckOptions {
  client: LlmClient;
  indexer: IndexerClient;
  threatModel: ThreatModel;
  findings: Array<Finding & { id: string }>;
  /** What the push changed. Shown to the reviewer, so it can tell a fix from a refactor. */
  changes?: ChangedFile[];
  /** Advisory lookups, to settle dependency findings by the version now installed. */
  osv?: OsvClient;
  limits?: Partial<ScanLimits>;
  pricing?: Pricing;
  signal?: AbortSignal;
  /** Called once for every model call that finishes (see `ScanOptions.onUsage`). Optional. */
  onUsage?: UsageSink;
}

export interface FixCheckResult {
  id: string;
  outcome: "fixed" | "open" | "stale";
  reason: string;
}

/** How far a cited line may have moved and still be the same line. */
const MAX_DRIFT = 400;

export async function checkFixes(options: FixCheckOptions): Promise<{ results: FixCheckResult[]; usage?: RoleUsage; costUsd?: number }> {
  const files = new Map<string, Promise<string[] | undefined>>();
  const lines = (path: string) => {
    let pending = files.get(path);
    if (!pending) {
      pending = readAll(options.indexer, path, options.signal);
      files.set(path, pending);
    }
    return pending;
  };

  // A dependency advisory the sweep matched by version is settled by the version now installed, not by a review.
  const swept = options.findings.filter((f) => sweptDependency(f));
  const results: FixCheckResult[] = swept.length ? await checkDependencies(swept, options) : [];
  const reviewed = options.findings.filter((f) => !sweptDependency(f));
  if (reviewed.length === 0) return { results };

  const anchored = await Promise.all(reviewed.map(async (finding) => ({ finding, moved: (await reanchor(finding, lines)) ?? (await withoutSink(finding, lines)) })));
  results.push(...anchored
    .filter(({ moved }) => !moved)
    .map(({ finding }) => ({ id: finding.id, outcome: "stale" as const, reason: "The cited code no longer exists where it was or nearby." })));

  const located = anchored.filter((entry): entry is { finding: Finding & { id: string }; moved: Finding } => !!entry.moved);
  if (located.length === 0) return { results };

  const verify = (entries: typeof located) =>
    verifyFindings({
      client: options.client,
      indexer: options.indexer,
      threatModel: options.threatModel,
      findings: entries.map(({ moved }) => moved),
      rechecks: options.changes ? entries.map(({ finding }) => renderChanges(finding, options.changes!)) : undefined,
      limits: options.limits,
      pricing: options.pricing,
      signal: options.signal,
      onUsage: options.onUsage,
    });
  const first = await verify(located);
  const verdicts = [...first.results];
  let usage = first.usage;
  let costUsd = first.costUsd;
  // A reviewer that ran out of turns ruled nothing either way: ask once more rather than leave a fixed bug open.
  const unruled = verdicts.flatMap((result, i) => (result.review && !result.review.ruled ? [i] : []));
  if (unruled.length > 0) {
    const second = await verify(unruled.map((i) => located[i]!));
    second.results.forEach((result, j) => (verdicts[unruled[j]!] = result));
    usage = sumUsage(usage, second.usage);
    costUsd = costUsd === undefined || second.costUsd === undefined ? costUsd : costUsd + second.costUsd;
  }
  verdicts.forEach((result, i) => {
    const id = located[i]!.finding.id;
    // Only code that now blocks the attack closes it. A ruling that it was never a vulnerability is a judgement
    // on the original report, not evidence of a fix, so it stays open for the team to dismiss.
    if (result.review?.verdict.verdict === "disproved") {
      results.push({ id, outcome: "fixed", reason: result.review.verdict.reasoning });
    } else {
      const reason = result.error ?? result.rejected?.join("; ") ?? result.review?.verdict.reasoning ?? "Still exploitable.";
      results.push({ id, outcome: "open", reason });
    }
  });
  return { results, usage, costUsd };
}

function sumUsage(a: RoleUsage, b: RoleUsage): RoleUsage {
  return {
    requests: a.requests + b.requests,
    retries: a.retries + b.retries,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

/** The package and version a sweep-made dependency finding names (`name@version ships a known …`). */
export function sweptDependency(finding: Finding): { name: string; version: string; advisories: string[] } | undefined {
  if (finding.category !== "vulnerable_dependency" || finding.sources?.length !== 1 || finding.sources[0] !== "vulnerable_dependency") return undefined;
  const match = /^(.+)@([^@\s]+) ships a known [a-z]+ vulnerability \(([^)]*)\)/.exec(finding.title);
  if (!match) return undefined;
  return { name: match[1]!, version: match[2]!, advisories: match[3]!.split(/,\s*/).filter(Boolean) };
}

/** Lockfiles and manifests: a push changing one may have fixed a dependency finding, whatever file it cites. */
const MANIFEST = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|uv\.lock|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?|gradle\.lockfile|packages\.lock\.json|[^/]+\.csproj|mix\.lock|pubspec\.lock)$/;

export function isDependencyManifest(path: string): boolean {
  return MANIFEST.test(path);
}

/**
 * Fixed when the package is gone or every installed version is clear of the
 * advisories the finding names; open while the reported version is installed
 * or a new one is still affected. Without an advisory lookup, an upgrade
 * stays open rather than be guessed.
 */
async function checkDependencies(findings: Array<Finding & { id: string }>, options: FixCheckOptions): Promise<FixCheckResult[]> {
  const { dependencies } = await options.indexer.call<{ dependencies: Dependency[] }>("deps", {}, options.signal);
  return Promise.all(
    findings.map(async (finding): Promise<FixCheckResult> => {
      const dep = sweptDependency(finding)!;
      const installed = dependencies.filter((d) => d.name === dep.name);
      if (installed.length === 0) return { id: finding.id, outcome: "fixed", reason: `${dep.name} is no longer a dependency.` };
      if (installed.some((d) => d.version === dep.version)) return { id: finding.id, outcome: "open", reason: `${dep.name}@${dep.version} is still installed.` };
      const versions = [...new Set(installed.map((d) => d.version))].join(", ");
      if (!options.osv) return { id: finding.id, outcome: "open", reason: `${dep.name} is now ${versions}; the advisories could not be checked.` };
      try {
        const advisories = (await options.osv.query(installed.map(({ ecosystem, name, version }) => ({ ecosystem, name, version })), options.signal)).flat();
        const named = new Set(dep.advisories);
        const still = advisories.filter((a) => named.has(a.id) || a.aliases.some((alias) => named.has(alias)));
        if (still.length > 0) return { id: finding.id, outcome: "open", reason: `${dep.name} is now ${versions}, still affected by ${[...new Set(still.map((a) => a.id))].join(", ")}.` };
        return { id: finding.id, outcome: "fixed", reason: `${dep.name} was upgraded to ${versions}, which the advisories (${dep.advisories.join(", ")}) no longer affect.` };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return { id: finding.id, outcome: "open", reason: `${dep.name} is now ${versions}; the advisory lookup failed.` };
      }
    }),
  );
}

/** Diff text shown per file, and in all: a reviewer needs the fix, not the whole push. */
const MAX_PATCH_CHARS = 6_000;
const MAX_CHANGES_CHARS = 16_000;

/**
 * The push's changes for the reviewer: the files the finding cites first,
 * then the rest, each patch capped, as a unified diff.
 */
export function renderChanges(finding: Finding, changes: ChangedFile[]): string {
  const cited = new Set([finding.entryPoint.file, ...finding.attackPath.map((step) => step.file)]);
  const ordered = [...changes].sort((a, b) => Number(cited.has(b.path)) - Number(cited.has(a.path)));
  const parts: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const file of ordered) {
    const header = `--- ${file.path} (${file.status}, +${file.additions} -${file.deletions})`;
    const body = file.patch ? (file.patch.length > MAX_PATCH_CHARS ? `${file.patch.slice(0, MAX_PATCH_CHARS)}\n… (patch truncated)` : file.patch) : "(no patch: binary or too large)";
    const part = `${header}\n${body}`;
    if (used + part.length > MAX_CHANGES_CHARS && parts.length > 0) {
      omitted++;
      continue;
    }
    parts.push(part);
    used += part.length;
  }
  if (omitted > 0) parts.push(`(${omitted} more changed file${omitted === 1 ? "" : "s"} not shown; read them with the tools if they may be on the attack's path)`);
  return parts.join("\n\n");
}

/**
 * The finding re-anchored on what is left of its path when the sink line
 * itself is gone (a fix often rewrites it): the located steps, the last of
 * them standing in as the sink. `undefined` when nothing can be located.
 */
async function withoutSink(finding: Finding, lines: (path: string) => Promise<string[] | undefined>): Promise<Finding | undefined> {
  const steps = await Promise.all(
    finding.attackPath.slice(0, -1).map(async (step) => {
      const text = excerptLine(step.excerpt, step.line);
      const content = await lines(step.file);
      if (!content || text === undefined) return undefined;
      const line = nearest(content, text, step.line);
      return line === undefined ? undefined : { ...step, line };
    }),
  );
  const kept = steps.filter((step): step is NonNullable<typeof step> => !!step);
  if (kept.length === 0) return undefined;
  const entryLines = await lines(finding.entryPoint.file);
  const entryPoint = entryLines && finding.entryPoint.line <= entryLines.length ? finding.entryPoint : { ...finding.entryPoint, file: kept[0]!.file, line: kept[0]!.line };
  const sink = finding.attackPath.at(-1)!;
  return { ...finding, entryPoint, attackPath: [...kept.slice(0, -1), { ...kept.at(-1)!, note: `${kept.at(-1)!.note} (the reported sink, ${sink.file}:${sink.line}, was changed or removed)` }] };
}

/**
 * The finding with every cited line moved to where its code now is, or
 * `undefined` if the sink's code cannot be found. Hops whose code is gone
 * are dropped; the entry point keeps its line if it still exists.
 */
export async function reanchor(finding: Finding, lines: (path: string) => Promise<string[] | undefined>): Promise<Finding | undefined> {
  const steps = await Promise.all(
    finding.attackPath.map(async (step) => {
      const text = excerptLine(step.excerpt, step.line);
      const content = await lines(step.file);
      if (!content || text === undefined) return undefined;
      const line = nearest(content, text, step.line);
      return line === undefined ? undefined : { ...step, line };
    }),
  );
  const sink = steps.at(-1);
  if (!sink) return undefined;
  const kept = steps.filter((step): step is NonNullable<typeof step> => !!step);
  const entryLines = await lines(finding.entryPoint.file);
  const entryPoint =
    entryLines && finding.entryPoint.line <= entryLines.length ? finding.entryPoint : { ...finding.entryPoint, file: kept[0]!.file, line: kept[0]!.line };
  return { ...finding, entryPoint, attackPath: kept };
}

/**
 * The code on `line` from an excerpt like ` 12| code`. A finding whose code
 * was deleted (resolved, then reopened) has no excerpt, so nothing to
 * re-anchor by: it reads as stale until a scan finds it again.
 */
export function excerptLine(excerpt: string | undefined, line: number): string | undefined {
  if (!excerpt) return undefined;
  for (const row of excerpt.split("\n")) {
    const match = /^\s*(\d+)\| ?(.*)$/.exec(row);
    if (match && Number(match[1]) === line) return match[2]!.trim() || undefined;
  }
  return undefined;
}

/**
 * Where a cited line is now: the exact text closest to where it was, else
 * the most similar line nearby (a fix usually rewrites the vulnerable line
 * itself), else nothing.
 */
function nearest(content: string[], text: string, previous: number): number | undefined {
  let best: number | undefined;
  for (let i = 0; i < content.length; i++) {
    if (content[i]!.trim() !== text) continue;
    const line = i + 1;
    if (Math.abs(line - previous) > MAX_DRIFT) continue;
    if (best === undefined || Math.abs(line - previous) < Math.abs(best - previous)) best = line;
  }
  if (best !== undefined) return best;

  const wanted = tokens(text);
  let bestScore = SIMILARITY;
  const from = Math.max(0, previous - 1 - SIMILAR_WINDOW);
  const to = Math.min(content.length, previous + SIMILAR_WINDOW);
  for (let i = from; i < to; i++) {
    const score = dice(wanted, tokens(content[i]!));
    if (score > bestScore) {
      bestScore = score;
      best = i + 1;
    }
  }
  return best;
}

/** How similar a rewritten line must be to count as the same line, and how far to look for it. */
const SIMILARITY = 0.5;
const SIMILAR_WINDOW = 40;

function tokens(line: string): Set<string> {
  return new Set(line.toLowerCase().match(/[a-z_$][\w$]*|\d+/g) ?? []);
}

/** Sørensen–Dice similarity of two token sets. */
function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** A whole file's lines, or `undefined` if it no longer exists. */
async function readAll(indexer: IndexerClient, path: string, signal?: AbortSignal): Promise<string[] | undefined> {
  const out: string[] = [];
  for (let start = 1; ; ) {
    let part: ReadResult;
    try {
      part = await indexer.call<ReadResult>("read_file", { path, startLine: start }, signal);
    } catch (error) {
      if ((error as { kind?: string }).kind === "bad_request") return out.length ? out : undefined;
      throw error;
    }
    out.push(...part.content.replace(/\n$/, "").split("\n"));
    if (part.endLine >= part.totalLines) return out;
    start = part.endLine + 1;
  }
}
