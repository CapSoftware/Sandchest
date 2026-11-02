/**
 * Entry-point recovery and authorization scoring with a typed-decision
 * classifier. Framework-specific route detection in the indexer is necessarily
 * incomplete — it cannot know every way every framework registers a handler
 * (Flask-RESTful resource methods, class-based controllers, RPC procedures).
 * Where it misses, real handlers look like ordinary functions, so their
 * directory never reaches the peer-group size the consistency check needs and
 * the attack surface the hunters see is too small.
 *
 * This stage closes that gap language-agnostically. It asks the indexer for
 * call-graph roots in the directories that already hold detected routes — the
 * small, server-side set of "functions nothing calls", which is where missed
 * handlers hide — and asks the classifier two neutral, structural questions per
 * candidate: is this an HTTP handler, and does it enforce an authorization
 * check. Recovered handlers merge into the route list (feeding recon, the
 * reachability proof, coverage and risk); the authorization scores feed the
 * peer-consistency check, replacing a brittle token list that could not see a
 * decorator or an unfamiliar guard.
 *
 * The classifier is optional: with none configured this stage is never called.
 * Every classifier call is isolated — a failure drops that one candidate, never
 * the scan — and the whole stage is best-effort: on trouble it returns what it
 * has and the pipeline proceeds on the deterministic facts alone.
 */
import type { IndexerClient } from "../indexer/client";
import type { Classifier } from "../llm/classifier";
import type { ReadResult, RouteInfo } from "./tools";

const HTTP_VERBS = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);

interface Definition {
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine: number;
}

export interface ClassifiedHandler {
  /** Symbol name, e.g. `ObjectPermissionsListResource.get`. */
  name: string;
  /** `file:line`. */
  at: string;
  /** Probability it enforces an appropriate authorization check (0–1). */
  authz: number;
  /** Apparent required access, or "not_an_endpoint". */
  authLevel: string;
}

export interface EntryRecovery {
  /** New entries to merge into the route list. */
  recovered: RouteInfo[];
  /** Every classified handler (recovered and already-detected), for peer-consistency. */
  handlers: ClassifiedHandler[];
  stats: {
    candidates: number;
    classified: number;
    recovered: number;
    refusals: number;
    failures: number;
    inputTokens: number;
  };
}

export interface ClassifyOptions {
  /** Minimum `is_http_handler` probability to treat a candidate as a handler. */
  handlerThreshold?: number;
  /** Hard cap on classifier calls, to bound latency and cost on large repos. */
  maxCandidates?: number;
  /** Concurrent classifier calls. */
  concurrency?: number;
  /** Overall wall-clock budget for the stage; on expiry it returns what it has. */
  budgetMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

const DEFAULTS = { handlerThreshold: 0.85, maxCandidates: 500, concurrency: 12, budgetMs: 60_000 } as const;

/** Files that are frontend assets, never server-side HTTP handlers. */
const FRONTEND = /\.(jsx|tsx|vue|svelte|css|scss|sass|less|html|htm|mdx|md|json|ya?ml|toml|lock)$/i;

/**
 * Last-segment patterns that are never an HTTP handler in any language:
 * serializers, converters and formatters. A conservative denylist that keeps a
 * misclassified helper out of the recovered routes and the consistency leads,
 * without encoding any framework's handler convention.
 */
const NOT_A_HANDLER = /(^|_)(serialize|deserialize)|^to_(dict|json)$|^(format|render)_/i;

function lastSegment(name: string): string {
  return name.split(".").pop() ?? name;
}

function directory(fileOrAt: string): string {
  const file = fileOrAt.includes(":") ? fileOrAt.slice(0, fileOrAt.lastIndexOf(":")) : fileOrAt;
  const slash = file.lastIndexOf("/");
  return slash >= 0 ? file.slice(0, slash) : "";
}

function verbOf(name: string): string {
  const last = name.split(".").pop()!.toLowerCase();
  return HTTP_VERBS.has(last) ? last.toUpperCase() : "ANY";
}

/**
 * Candidate definitions to classify. When the route detector found routes, the
 * missed handlers are overwhelmingly their siblings, so we take *every*
 * function and method in those directories (recall matters most — the
 * vulnerable handler is often a common-named method the call graph resolves as
 * "called", which a roots-only filter would drop). When no route was detected,
 * there is no server-side anchor, so we fall back to call-graph roots across the
 * backend — entry points or dead code — to bound the work. Frontend files and
 * obvious non-handlers are always excluded, and the set is capped.
 */
async function fetchCandidates(indexer: IndexerClient, routes: RouteInfo[], max: number, signal?: AbortSignal): Promise<Definition[] | null> {
  const routeDirs = [...new Set(routes.map((r) => directory(r.at)).filter(Boolean))];
  let pool: Definition[];
  try {
    if (routeDirs.length > 0) {
      const perDir = await Promise.all(routeDirs.map((dir) => indexer.call<{ definitions: Definition[] }>("definitions", { path: `${dir}/`, limit: 10_000 }, signal).then((r) => r.definitions)));
      const byKey = new Map<string, Definition>();
      for (const def of perDir.flat()) byKey.set(`${def.file}\u0000${def.name}\u0000${def.line}`, def);
      pool = [...byKey.values()];
    } else {
      pool = (await indexer.call<{ definitions: Definition[] }>("definitions", { roots: true, limit: 20_000 }, signal)).definitions;
    }
  } catch {
    return null; // indexer too old (no `definitions` tool) or unavailable.
  }
  const usable = pool.filter((d) => !FRONTEND.test(d.file) && !NOT_A_HANDLER.test(lastSegment(d.name)));
  // Methods first (class-based handlers are the common miss), then by location — a stable, bounded set.
  usable.sort((a, b) => Number(b.kind === "method") - Number(a.kind === "method") || a.file.localeCompare(b.file) || a.line - b.line);
  return usable.slice(0, max);
}

async function readWindow(indexer: IndexerClient, file: string, line: number, endLine: number | undefined, signal?: AbortSignal): Promise<string> {
  const start = Math.max(1, line - 6); // a few lines back to catch decorators / annotations
  const end = Math.min(endLine ? endLine + 1 : start + 60, start + 90);
  const result = await indexer.call<ReadResult>("read_file", { path: file, startLine: start, endLine: end }, signal);
  return result.content;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

const QUESTIONS = {
  is_http_handler: {
    type: "noul" as const,
    instructions:
      "Is this an HTTP request handler / web API endpoint — a function the web framework invokes to serve an incoming request (a route handler, a framework resource method like a Flask-RESTful Resource's get/post/delete, a server action, or an RPC procedure)? Answer no for helper functions, serializers, formatters, model methods and internal utilities.",
  },
  enforces_authz: {
    type: "noul" as const,
    instructions:
      "Does this code enforce an authorization or permission check appropriate to what it does before acting — a decorator, guard, or call that verifies the current user may perform this action or access this specific object (not merely that they are logged in)? Answer no if it performs a sensitive read or write with no such check.",
  },
  auth_level: {
    type: "choice" as const,
    instructions: "If this is an endpoint, what access does it appear to require?",
    criteria: { public: "no authentication", authenticated: "any logged-in user", admin: "admin or privileged only", not_an_endpoint: "this is not an HTTP endpoint" },
  },
};

/** One classified candidate, or null if the classifier call failed or refused. */
interface Classified {
  def: Definition;
  isHandler: number;
  authz: number;
  authLevel: string;
}

/**
 * Recovers handlers the route detector missed and scores every handler's
 * authorization, using the classifier. Best-effort and side-effect-free.
 */
export async function classifyEntryPoints(indexer: IndexerClient, classifier: Classifier, routes: RouteInfo[], options: ClassifyOptions = {}): Promise<EntryRecovery> {
  const handlerThreshold = options.handlerThreshold ?? DEFAULTS.handlerThreshold;
  const max = options.maxCandidates ?? DEFAULTS.maxCandidates;
  const concurrency = options.concurrency ?? DEFAULTS.concurrency;
  // A stage budget so a slow or hung classifier endpoint can never stall the scan: when it fires,
  // in-flight calls abort and the rest are skipped, and the stage returns the handlers it did classify.
  const budget = AbortSignal.timeout(options.budgetMs ?? DEFAULTS.budgetMs);
  const signal = options.signal ? AbortSignal.any([options.signal, budget]) : budget;
  /** True when the scan itself was cancelled (fatal), as opposed to our own budget expiring. */
  const cancelled = () => options.signal?.aborted ?? false;

  const empty: EntryRecovery = { recovered: [], handlers: [], stats: { candidates: 0, classified: 0, recovered: 0, refusals: 0, failures: 0, inputTokens: 0 } };

  const pool = await fetchCandidates(indexer, routes, max, signal);
  if (pool === null) return empty; // indexer too old (no `definitions` tool) or unavailable: skip cleanly.

  const detectedKeys = new Set<string>();
  const detected: Array<{ name: string; file: string; line: number }> = [];
  for (const route of routes) {
    for (const handler of route.handlers) {
      const [name, loc] = handler.split(" @ ");
      if (!name || !loc) continue;
      const file = loc.slice(0, loc.lastIndexOf(":"));
      const line = Number(loc.slice(loc.lastIndexOf(":") + 1));
      const key = `${file}\u0000${name}`;
      if (detectedKeys.has(key)) continue;
      detectedKeys.add(key);
      detected.push({ name, file, line });
    }
  }

  const candidates = pool.filter((d) => !detectedKeys.has(`${d.file}\u0000${d.name}`));
  // Classify recovered candidates (need the handler verdict) and detected handlers (need the authz score for peer comparison).
  const toClassify: Definition[] = [
    ...candidates,
    ...detected.map((d) => ({ name: d.name, kind: "method", file: d.file, line: d.line, endLine: d.line + 40 })),
  ];
  if (toClassify.length === 0) return empty;
  options.onProgress?.(`Classifying ${candidates.length} entry-point candidates`);

  let refusals = 0;
  let failures = 0;
  let inputTokens = 0;

  const classified = await mapLimit(toClassify, concurrency, async (def): Promise<Classified | null> => {
    // Budget expired (or scan cancelled): stop spending on more candidates.
    if (signal.aborted) {
      if (cancelled()) throw signal.reason;
      return null;
    }
    let state: string;
    try {
      state = `# ${def.name} in ${def.file}\n${await readWindow(indexer, def.file, def.line, def.endLine, signal)}`;
    } catch (error) {
      if (cancelled()) throw error;
      failures++;
      return null;
    }
    try {
      const { answers, inputTokens: used } = await classifier.ask(state, QUESTIONS, signal);
      inputTokens += used;
      const handler = answers.is_http_handler;
      const authz = answers.enforces_authz;
      const level = answers.auth_level;
      return {
        def,
        isHandler: handler?.type === "noul" ? handler.noul : 0,
        authz: authz?.type === "noul" ? authz.noul : 0.5,
        authLevel: level?.type === "choice" ? level.choice : "unknown",
      };
    } catch (error) {
      if (cancelled()) throw error;
      if (/refus|cannot|policy|unsafe/i.test((error as Error).message)) refusals++;
      else failures++;
      return null;
    }
  });

  const recovered: RouteInfo[] = [];
  const handlers: ClassifiedHandler[] = [];
  for (const result of classified) {
    if (!result) continue;
    if (result.isHandler < handlerThreshold) continue;
    const { def } = result;
    const at = `${def.file}:${def.line}`;
    handlers.push({ name: def.name, at, authz: result.authz, authLevel: result.authLevel });
    if (!detectedKeys.has(`${def.file}\u0000${def.name}`)) {
      recovered.push({ method: verbOf(def.name), path: def.name, at, chain: [], handlers: [`${def.name} @ ${at}`], framework: "recovered" });
    }
  }

  return { recovered, handlers, stats: { candidates: candidates.length, classified: classified.filter(Boolean).length, recovered: recovered.length, refusals, failures, inputTokens } };
}
