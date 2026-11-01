/**
 * Fix checks: after a push, re-check open findings whose files changed.
 * Code moves, so each cited line is first re-located by its stored text.
 * A finding is fixed only when the skeptic disproves it on the new code;
 * one whose sink cannot be found is stale, never silently closed.
 */
import type { IndexerClient } from "../indexer/client";
import type { LlmClient } from "../llm";
import type { ScanLimits } from "./context";
import type { Pricing, RoleUsage } from "./metrics";
import { verifyFindings } from "./pipeline";
import type { Finding, ThreatModel } from "./schema";
import type { ReadResult } from "./tools";

export interface FixCheckOptions {
  client: LlmClient;
  indexer: IndexerClient;
  threatModel: ThreatModel;
  findings: Array<Finding & { id: string }>;
  limits?: Partial<ScanLimits>;
  pricing?: Pricing;
  signal?: AbortSignal;
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

  const anchored = await Promise.all(options.findings.map(async (finding) => ({ finding, moved: await reanchor(finding, lines) })));
  const results: FixCheckResult[] = anchored
    .filter(({ moved }) => !moved)
    .map(({ finding }) => ({ id: finding.id, outcome: "stale", reason: "The cited sink code no longer exists where it was or nearby." }));

  const located = anchored.filter((entry): entry is { finding: Finding & { id: string }; moved: Finding } => !!entry.moved);
  if (located.length === 0) return { results };

  const verified = await verifyFindings({
    client: options.client,
    indexer: options.indexer,
    threatModel: options.threatModel,
    findings: located.map(({ moved }) => moved),
    limits: options.limits,
    pricing: options.pricing,
    signal: options.signal,
  });
  verified.results.forEach((result, i) => {
    const id = located[i]!.finding.id;
    if (result.review?.verdict.verdict === "disproved") {
      results.push({ id, outcome: "fixed", reason: result.review.verdict.reasoning });
    } else {
      const reason = result.error ?? result.rejected?.join("; ") ?? result.review?.verdict.reasoning ?? "Still exploitable.";
      results.push({ id, outcome: "open", reason });
    }
  });
  return { results, usage: verified.usage, costUsd: verified.costUsd };
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

/** The code on `line` from an excerpt like ` 12| code`. */
export function excerptLine(excerpt: string, line: number): string | undefined {
  for (const row of excerpt.split("\n")) {
    const match = /^\s*(\d+)\| ?(.*)$/.exec(row);
    if (match && Number(match[1]) === line) return match[2]!.trim() || undefined;
  }
  return undefined;
}

/** The line holding `text` closest to where it used to be. */
function nearest(content: string[], text: string, previous: number): number | undefined {
  let best: number | undefined;
  for (let i = 0; i < content.length; i++) {
    if (content[i]!.trim() !== text) continue;
    const line = i + 1;
    if (Math.abs(line - previous) > MAX_DRIFT) continue;
    if (best === undefined || Math.abs(line - previous) < Math.abs(best - previous)) best = line;
  }
  return best;
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
