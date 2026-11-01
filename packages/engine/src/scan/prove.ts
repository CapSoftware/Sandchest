/**
 * Code-path proof: for every surviving finding, re-prove its attack path
 * against the index — deterministically, without running anything. This is
 * what lets validation work on any codebase (including ones that cannot be
 * booted: no database, no env, a monorepo) and in every scan.
 *
 * It asks the index two things it already knows how to answer:
 *   - does a call path run from the entry point's function to the sink's
 *     function? (`trace`)
 *   - does a request handler reach the cited sink? (`sinks`, which carries
 *     route-reachability computed at index time)
 *
 * When either holds, the finding is `path_confirmed`: the attacker-reachable
 * path the hunter described is real in the code, not a plausible story. This
 * is weaker than runtime `verified` (we did not execute the attack), so it
 * never claims that word.
 *
 * It is asymmetric, like the skeptic and like runtime validation: it only ever
 * *adds* a confirmation. The index resolves call edges by name and misses
 * dynamic dispatch and framework-invoked handlers, so "no path found" is not
 * evidence the finding is false — the finding stands untouched.
 */
import type { IndexerClient } from "../indexer/client";
import { normalizePath } from "./gate";
import type { Finding, Validation } from "./schema";
import type { SinkInfo } from "./tools";

const METHOD = "code-path";

interface LocateResult {
  locations: Array<{ file: string; line: number; exists: boolean; symbol?: string | null }>;
}
interface TraceResult {
  paths: Array<{ hops: Array<{ symbol: string; definedAt: string }> }>;
}
interface SinksResult {
  sinks: SinkInfo[];
}

const confirmed = (detail: string): Validation => ({ status: "path_confirmed", method: METHOD, detail });
const inconclusive = (detail: string): Validation => ({ status: "inconclusive", method: METHOD, detail });

/** A `METHOD /path` route embedded in an entry-point description, which `trace` resolves to a handler. */
function routeOf(description: string): string | null {
  const m = description.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)/i);
  return m ? `${m[1]!.toUpperCase()} ${m[2]!.replace(/[,.;]+$/, "")}` : null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Proves one finding's path through the index. Pure read-only index calls. */
export async function proveFinding(indexer: IndexerClient, finding: Finding, signal?: AbortSignal): Promise<Validation> {
  if (finding.attackPath.length === 0) return inconclusive("the finding cites no code path");
  const cited = finding.attackPath.map((step) => ({ file: normalizePath(step.file), line: step.line }));

  const { locations } = await indexer.call<LocateResult>("locate", { locations: cited }, signal);
  if (locations.length !== cited.length || locations.some((l) => !l.exists)) {
    return inconclusive("the cited code has moved since it was found; a fresh scan will re-anchor it");
  }
  const entry = locations[0]!;
  const sink = locations.at(-1)!;

  // Trace a call path to the sink's function. We try several entry anchors, not
  // just the hunter's cited symbol: the finding's own route first, because the
  // index resolves routes to handlers framework-aware — and a route/server-action
  // handler has no in-graph callers, so a bare function→function trace fails
  // exactly on the framework-handler findings that matter (measured on Cap).
  // Trying more than one real anchor also stops the result flipping run-to-run
  // when a different hunter cites the path slightly differently.
  if (sink.symbol) {
    const anchors = [routeOf(finding.entryPoint.description), entry.symbol].filter((a): a is string => !!a && a !== sink.symbol);
    for (const from of dedupe(anchors)) {
      const traced = await indexer.call<TraceResult>("trace", { from, to: sink.symbol }, signal).catch(() => ({ paths: [] }) as TraceResult);
      if ((traced.paths ?? []).length > 0) return confirmed(`the index traces a call path from ${from} to ${sink.symbol}`);
    }
  }

  // Classic sink: the index already determined a request handler reaches this line.
  const at = `${sink.file}:${sink.line}`;
  const result = await indexer.call<SinksResult>("sinks", { path: sink.file }, signal).catch(() => ({ sinks: [] }) as SinksResult);
  if ((result.sinks ?? []).some((s) => s.at === at && s.reachable)) {
    return confirmed("the index confirms a request handler reaches the cited sink");
  }

  return inconclusive("the index could not confirm the path on its own; the link may be dynamic or framework-invoked");
}

export interface ProveOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

/**
 * Proves every finding's path, in place. Index calls are cheap and local, so
 * they run together. A finding whose proof errors is left untouched.
 */
export async function proveFindings(indexer: IndexerClient, findings: Finding[], options: ProveOptions = {}): Promise<void> {
  await Promise.all(
    findings.map(async (finding) => {
      try {
        finding.validation = await proveFinding(indexer, finding, options.signal);
        if (finding.validation.status === "path_confirmed") options.onProgress?.(`Confirmed the path for ${finding.title}.`);
      } catch {
        // Best-effort: proof must never drop a finding or fail the scan.
      }
    }),
  );
}
