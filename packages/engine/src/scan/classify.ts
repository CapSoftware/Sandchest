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

/** The indexer returns at most this many definitions per call. */
const DEFINITIONS_PER_CALL = 20_000;
const HTTP_VERBS = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);

export interface Definition {
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

const DEFAULTS = { handlerThreshold: 0.85, maxCandidates: 1000, concurrency: 24, budgetMs: 120_000 } as const;

/** Files that are frontend assets, never server-side HTTP handlers. */
const FRONTEND = /\.(vue|svelte|css|scss|sass|less|html|htm|mdx|md|json|ya?ml|toml|lock)$|(^|\/)(frontend|web_src|stimulus|webcomponents)\//i;
/** JSX is usually a UI component, but server code is sometimes written in it (an RPC router in `.tsx`). */
const JSX = /\.(jsx|tsx)$/i;
const SERVER_PATH = /(^|\/)(server|api|trpc)\//i;
/** An ordering hint only: code that looks client-side is classified last. */
const CLIENT_HINT = /(^|\/)[^/]*(client|front)[^/]*\/|(^|\/)(ui|components|editor)\//i;
const isFrontend = (file: string) => FRONTEND.test(file) || (JSX.test(file) && !SERVER_PATH.test(file));

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
 * Where handlers usually live: controller, view, endpoint, resource and route
 * files or directories. A ranking hint only (the classifier still decides what
 * is a handler), so files named this way are classified first.
 */
const HANDLER_PATH = /(^|\/)(controllers?|views?|handlers?|endpoints?|resources?|resolvers?|routes?|routers?|api|rest|rpc)(\/|_|\.|$)|(controller|endpoint|resource|resolver|handler|views?|router|api)s?\.[a-z]+$/i;

/**
 * Candidate definitions to classify, from three pools in order:
 * - every function and method in files named like handlers (above), wherever
 *   they are. Route rules often see the route table but not its handlers
 *   (Django `urls.py` names views in another directory), or nothing at all
 *   (frameworks with no rule);
 * - every definition in directories that hold detected routes: missed handlers
 *   are often their siblings, and often common-named methods the call graph
 *   resolves as "called", which a roots-only filter would drop;
 * - with no route detected, call-graph roots across the backend (entry points
 *   or dead code), to bound the work.
 * Frontend files and obvious non-handlers are excluded. Within a pool the
 * candidates are taken round-robin across files, so the cap spreads over every
 * file instead of exhausting the first few alphabetically.
 */
export async function entryPointCandidates(indexer: IndexerClient, routes: RouteInfo[], max: number, signal?: AbortSignal): Promise<Definition[] | null> {
  const routeDirs = [...new Set(routes.map((r) => directory(r.at)).filter(Boolean))];
  const pools: Definition[][] = [];
  try {
    const all = await allDefinitions(indexer, "", signal);
    pools.push(all.filter((d) => HANDLER_PATH.test(d.file)));
    if (routeDirs.length > 0) {
      const perDir = await Promise.all(routeDirs.map((dir) => indexer.call<{ definitions: Definition[] }>("definitions", { path: `${dir}/`, limit: 10_000 }, signal).then((r) => r.definitions)));
      pools.push(perDir.flat());
    } else {
      pools.push((await indexer.call<{ definitions: Definition[] }>("definitions", { roots: true, limit: 20_000 }, signal)).definitions);
    }
  } catch {
    return null; // indexer too old (no `definitions` tool) or unavailable.
  }
  // Handlers the route rules already found are scored separately: they must not take the cap's slots.
  const { keys: detected } = detectedHandlers(routes);
  const seen = new Set<string>();
  const out: Definition[] = [];
  for (const pool of pools) {
    const usable = pool.filter((d) => {
      const key = `${d.file}\u0000${d.name}\u0000${d.line}`;
      if (seen.has(key) || detected.has(`${d.file}\u0000${d.name}`) || isFrontend(d.file) || NOT_A_HANDLER.test(lastSegment(d.name))) return false;
      seen.add(key);
      return true;
    });
    // Client-looking paths last. Nothing is dropped, so this only decides what a capped run classifies.
    out.push(...roundRobin(usable.filter((d) => !CLIENT_HINT.test(d.file))), ...roundRobin(usable.filter((d) => CLIENT_HINT.test(d.file))));
  }
  return out.slice(0, max);
}

/** Handlers the route rules found, by `file\u0000name`, and as a list. */
function detectedHandlers(routes: RouteInfo[]): { keys: Set<string>; list: Array<{ name: string; file: string; line: number }> } {
  const keys = new Set<string>();
  const list: Array<{ name: string; file: string; line: number }> = [];
  for (const route of routes) {
    for (const handler of route.handlers) {
      const [name, loc] = handler.split(" @ ");
      if (!name || !loc) continue;
      const file = loc.slice(0, loc.lastIndexOf(":"));
      const line = Number(loc.slice(loc.lastIndexOf(":") + 1));
      const key = `${file}\u0000${name}`;
      if (keys.has(key)) continue;
      keys.add(key);
      list.push({ name, file, line });
    }
  }
  return { keys, list };
}

/**
 * Every definition under `dir` (a `path/` prefix, or "" for the repository),
 * however large it is. One call returns at most 20,000, which cut off whole
 * directories of the largest repositories, controllers included; a directory
 * over the limit is read one child at a time instead.
 */
async function allDefinitions(indexer: IndexerClient, dir: string, signal?: AbortSignal, depth = 0): Promise<Definition[]> {
  const first = await indexer.call<{ definitions: Definition[]; total: number }>("definitions", { ...(dir && { path: dir }), limit: DEFINITIONS_PER_CALL }, signal);
  if (first.total <= first.definitions.length || depth >= 8) return first.definitions;
  const listing = await indexer.call<{ entries: Array<{ name: string; type: "dir" | "file" }> }>("list_dir", { path: dir.replace(/\/$/, "") }, signal);
  const parts = await Promise.all(
    listing.entries.map((entry) =>
      entry.type === "dir"
        ? allDefinitions(indexer, `${dir}${entry.name}/`, signal, depth + 1)
        : indexer.call<{ definitions: Definition[] }>("definitions", { path: `${dir}${entry.name}`, limit: DEFINITIONS_PER_CALL }, signal).then((r) => r.definitions.filter((d) => d.file === `${dir}${entry.name}`)),
    ),
  );
  return parts.flat();
}

/**
 * The route list with recovered handlers merged in: detected routes that name a
 * handler, then the recovered ones, then route table entries that name no
 * handler (the hunter still has to resolve those). The access-control hunters
 * take entry points in this order, up to their cap.
 */
export function mergeRecovered(routes: RouteInfo[], recovered: RouteInfo[]): RouteInfo[] {
  if (recovered.length === 0) return routes;
  return [...routes.filter((r) => r.handlers.length), ...recovered, ...routes.filter((r) => !r.handlers.length)];
}

/** One definition from each file in turn (methods first within a file, then by line), files in path order. */
function roundRobin(defs: Definition[]): Definition[] {
  const byFile = new Map<string, Definition[]>();
  for (const def of defs) byFile.set(def.file, [...(byFile.get(def.file) ?? []), def]);
  const queues = [...byFile.keys()].sort().map((file) => byFile.get(file)!.sort((a, b) => Number(b.kind === "method") - Number(a.kind === "method") || a.line - b.line));
  const out: Definition[] = [];
  for (let i = 0; out.length < defs.length; i++) for (const queue of queues) if (queue[i]) out.push(queue[i]!);
  return out;
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

  const pool = await entryPointCandidates(indexer, routes, max, signal);
  if (pool === null) return empty; // indexer too old (no `definitions` tool) or unavailable: skip cleanly.

  const { keys: detectedKeys, list: detected } = detectedHandlers(routes);

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
