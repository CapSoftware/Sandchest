/**
 * Peer-consistency: find handlers that skip an authorization check their
 * siblings apply. This is how a human reviewer actually spots broken access
 * control — not by proving a policy (there is none in the code), but by
 * noticing one handler in a family deviates from the rest. The technique is
 * old and sound (RoleCast for web authz; Chucky's missing-check detection;
 * Engler's "bugs as deviant behaviour").
 *
 * It is the deterministic half of the hybrid: the check proves what it can —
 * "this handler, unlike its peers, never calls an authorization guard" — and
 * then hands the model a sharp, grounded question (is that gap reachable and
 * exploitable?) instead of asking it to re-derive everything. Detection is
 * reliable and works on any codebase; adjudication stays with the skeptic.
 *
 * It emits a lead, never a finding: like every deterministic lead, the model
 * investigates it and the skeptic gates it, so it raises recall and reliability
 * on the hardest, most variance-prone class without asserting a bug itself.
 */
import type { IndexerClient } from "../indexer/client";
import type { Lead } from "./schema";
import type { RouteInfo } from "./tools";

/**
 * Substrings that mark an authorization / ownership / membership guard,
 * matched against the lowercased callee. Deliberately specific — generic
 * collection and fetch calls (`map`, `find`, `get`) must not read as guards.
 */
const AUTHZ_GUARDS: readonly string[] = [
  "authoriz",
  "authenticat",
  "getcurrentuser",
  "getsession",
  "requireuser",
  "requireauth",
  "requireadmin",
  "requireorg",
  "requirespace",
  "requiremember",
  "canmanage",
  "canview",
  "canedit",
  "canaccess",
  "candelete",
  "cancreate",
  "hasaccess",
  "haspermission",
  "checkaccess",
  "checkpermission",
  "getaccess",
  "getspaceaccess",
  "getorganizationaccess",
  "assertowner",
  "assertaccess",
  "ensureowner",
  "ensureaccess",
  "ownedby",
  "getownedby",
  "isowner",
  "verifyowner",
  "ismember",
  "membership",
  "belongsto",
  "ability",
  "ensurecanedit",
];

/** The guard this callee represents, or null. Returns the callee's last segment as its identity. */
function guardOf(callee: string): string | null {
  const lower = callee.toLowerCase();
  if (!AUTHZ_GUARDS.some((token) => lower.includes(token))) return null;
  return callee.split(/[.(]/).filter(Boolean).pop() ?? callee;
}

export interface HandlerGuards {
  name: string;
  /** `file:line` of the handler. */
  at: string;
  /** Guard callees the handler invokes (de-duplicated by the caller or not). */
  guards: string[];
}

export interface Deviation {
  name: string;
  at: string;
  /** Guards the handler's peers apply (majority of the group). */
  expected: string[];
  /** Guards this handler applies. */
  has: string[];
}

export interface DeviationOptions {
  /** Smallest sibling group to judge consistency over. */
  minGroup: number;
  /** Fraction of a group that must share a guard for it to count as expected. */
  majority: number;
}

const DEFAULTS: DeviationOptions = { minGroup: 3, majority: 0.5 };

function directory(at: string): string {
  const file = at.slice(0, at.lastIndexOf(":"));
  const slash = file.lastIndexOf("/");
  return slash >= 0 ? file.slice(0, slash) : "";
}

/**
 * Pure deviation detection: within each directory of ≥ `minGroup` handlers,
 * the guards a majority apply are "expected"; a handler that applies fewer
 * guards than expected and is missing at least one of them is a deviation.
 */
export function detectAuthzDeviations(handlers: HandlerGuards[], options: DeviationOptions = DEFAULTS): Deviation[] {
  const groups = new Map<string, HandlerGuards[]>();
  for (const handler of handlers) {
    const dir = directory(handler.at);
    (groups.get(dir) ?? groups.set(dir, []).get(dir)!).push(handler);
  }

  const deviations: Deviation[] = [];
  for (const group of groups.values()) {
    if (group.length < options.minGroup) continue;
    const need = Math.ceil(group.length * options.majority);
    const tally = new Map<string, number>();
    for (const handler of group) for (const guard of new Set(handler.guards)) tally.set(guard, (tally.get(guard) ?? 0) + 1);
    const expected = [...tally].filter(([, n]) => n >= need).map(([guard]) => guard);
    if (expected.length === 0) continue;

    for (const handler of group) {
      const has = new Set(handler.guards);
      const missing = expected.filter((guard) => !has.has(guard));
      // A deviation: missing a guard its peers share, and under-guarded overall (not just a naming difference).
      if (missing.length > 0 && has.size < expected.length) {
        deviations.push({ name: handler.name, at: handler.at, expected, has: [...has] });
      }
    }
  }
  return deviations;
}

/** A handler scored by the classifier: how likely it enforces authorization. */
export interface ScoredHandler {
  name: string;
  at: string;
  /** Probability it enforces an appropriate authorization check (0–1). */
  authz: number;
  /** Apparent required access. A `public` endpoint is not a missing-check deviation. */
  authLevel?: string;
}

export interface ScoreDeviationOptions {
  minGroup: number;
  /** A peer counts as enforcing authorization at or above this probability. */
  enforcingAt: number;
  /** A handler is a candidate deviation at or below this probability. */
  deviantAt: number;
  /** Fraction of peers that must be enforcing for the gap to count. */
  peerShare: number;
}

const SCORE_DEFAULTS: ScoreDeviationOptions = { minGroup: 3, enforcingAt: 0.6, deviantAt: 0.4, peerShare: 0.6 };

/**
 * Peer-consistency over classifier authorization scores: within each directory
 * of ≥ `minGroup` handlers, a handler whose score is low while most of its
 * peers score high is a deviation. This is the language-agnostic counterpart of
 * {@link detectAuthzDeviations}: it reads the concept of "enforces authz" from
 * the classifier rather than matching guard-call names, so it sees decorators
 * and unfamiliar frameworks the token list cannot.
 */
export function detectAuthzScoreDeviations(handlers: ScoredHandler[], options: ScoreDeviationOptions = SCORE_DEFAULTS): Deviation[] {
  const groups = new Map<string, ScoredHandler[]>();
  for (const handler of handlers) {
    const dir = directory(handler.at);
    (groups.get(dir) ?? groups.set(dir, []).get(dir)!).push(handler);
  }

  const deviations: Deviation[] = [];
  for (const group of groups.values()) {
    if (group.length < options.minGroup) continue;
    for (const handler of group) {
      if (handler.authz > options.deviantAt) continue;
      // An intentionally public endpoint is expected to lack authorization — not a deviation.
      if (handler.authLevel === "public") continue;
      const peers = group.filter((other) => other !== handler);
      const enforcing = peers.filter((peer) => peer.authz >= options.enforcingAt).length;
      if (peers.length > 0 && enforcing / peers.length >= options.peerShare) {
        deviations.push({ name: handler.name, at: handler.at, expected: ["an authorization check"], has: [] });
      }
    }
  }
  return deviations;
}

/**
 * Leads from classifier authorization scores. One `missing_check` lead per
 * handler that scores low on authorization while its directory peers score
 * high — the sharp, grounded question the model then investigates.
 */
export function authzScoreLeads(handlers: ScoredHandler[], nextId: () => string, options?: ScoreDeviationOptions): Lead[] {
  return detectAuthzScoreDeviations(handlers, options).map((dev) => ({
    id: nextId(),
    kind: "missing_check",
    title: `${dev.name} may skip an authorization check its sibling handlers apply`,
    at: dev.at,
    detail: `Sibling handlers in the same module appear to enforce an authorization check; this one does not. Check whether an attacker can reach or change an object they do not own or belong to.`,
  }));
}

interface CalleesResult {
  definitions: Array<{ calls: Array<{ call: string }> }>;
}

/**
 * Finds each entry handler's authorization guards from the call graph and
 * returns a `missing_check` lead for every handler that deviates from its
 * peers. The lead poses the model the sharp question, with no code excerpt.
 */
export async function authzConsistencyLeads(indexer: IndexerClient, routes: RouteInfo[], nextId: () => string, signal?: AbortSignal): Promise<Lead[]> {
  const handlers: HandlerGuards[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    const handler = route.handlers[0];
    if (!handler) continue;
    const [name, at] = handler.split(" @ ");
    if (!name || !at || seen.has(at)) continue;
    seen.add(at);
    const result = await indexer.call<CalleesResult>("callees", { symbol: name }, signal).catch(() => ({ definitions: [] }) as CalleesResult);
    const guards = new Set<string>();
    for (const def of result.definitions) for (const { call } of def.calls) {
      const guard = guardOf(call);
      if (guard) guards.add(guard);
    }
    handlers.push({ name, at, guards: [...guards] });
  }

  return detectAuthzDeviations(handlers).map((dev) => ({
    id: nextId(),
    kind: "missing_check",
    title: `${dev.name} may skip an authorization check its sibling handlers apply`,
    at: dev.at,
    detail: `Peer handlers in the same module apply ${dev.expected.join(", ")}; this one applies ${dev.has.length ? dev.has.join(", ") : "no authorization guard"}. Check whether an attacker can reach or change an object they do not own or belong to.`,
  }));
}
