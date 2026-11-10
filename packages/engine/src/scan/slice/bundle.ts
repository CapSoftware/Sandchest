/**
 * The code a cheap scan reads, cut into packets of about 1800 lines.
 *
 * Slices: per entry point, only the code that decides whether it is exploitable: the handler body, the guards
 * in front of it (route chain) and the security-relevant helpers it calls (1 hop; 2 hops for auth-shaped
 * helpers). Shared guards and helpers are hoisted once per packet so they form a cached prefix.
 *
 * Whole files: every server file ranked by risk, in 400-line chunks, up to a line budget. Small codebases and
 * ones whose routes the indexer cannot map get whole files only; large ones get slices plus whole files.
 */
import type { IndexerClient } from "../../indexer/client";
import { lineCount, riskScore, serverFiles } from "./source";

export interface Span {
  key: string;
  name: string;
  file: string;
  start: number;
  end: number;
}

export interface Entry {
  id: string;
  /** HTTP method, `FILE` for a whole-file chunk, `CHANGED` for a changed region. */
  method: string;
  path: string;
  /** `file:line` the entry is anchored at. */
  at: string;
  handler: Span;
  /** Keys into `Bundle.spans`. */
  guards: string[];
  helpers: string[];
  risk?: number;
  /** Changed line ranges inside the handler span (change packets only). */
  hunks?: Array<[number, number]>;
}

export interface Packet {
  name: string;
  /** Keys into `Bundle.spans`, shown once before the entries. */
  shared: string[];
  entries: Entry[];
}

export interface Bundle {
  packets: Packet[];
  spans: Record<string, Span>;
  stats: { entries: number; packets: number; totalLines: number; mode?: BundleMode };
}

export type BundleMode = "slices" | "whole" | "hybrid";

export const BUNDLE_LIMITS = {
  /** Lines per packet. */
  packetLines: 1_800,
  /** Lines per whole-file chunk. */
  chunkLines: 400,
  /** At or under this many server lines, whole files only. */
  smallServerLines: 40_000,
  /** Fewer slice entries than this (routes the indexer cannot map): whole files only. */
  minSliceEntries: 20,
  /** Line budget for whole files only. */
  wholeBudget: 60_000,
  /** Line budget for slices plus whole files. */
  hybridBudget: 40_000,
  /** Routes resolved against the indexer at once. The result is the same whatever this is. */
  indexConcurrency: 16,
};

/** `fn` over `items`, at most `limit` at a time, results in the items' order. The first rejection rejects the whole. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

interface Def {
  name: string;
  file: string;
  line: number;
  endLine: number;
}

interface RouteRow {
  at: string;
  method: string;
  path: string;
  chain?: string[];
  handlers?: string[];
}

const FAMILY: Array<[RegExp, string]> = [
  [/\.(ts|tsx|js|jsx|mjs|cjs)$/, "js"],
  [/\.py$/, "py"],
  [/\.rb$/, "rb"],
  [/\.go$/, "go"],
  [/\.(java|kt)$/, "jvm"],
  [/\.php$/, "php"],
  [/\.rs$/, "rs"],
];
const family = (f: string) => FAMILY.find(([re]) => re.test(f))?.[1] ?? f.slice(f.lastIndexOf("."));
const SKIP = /(^|\/)(node_modules|vendor|tests?|__tests__|spec|fixtures?|dist|build)\//;
const AUTHY = /auth|perm|polic|owner|member|role|session|user|access|allow|guard|require|verify|check|limit|valid|can[A-Z_]|is[A-Z_]|admin|token|secret|sign|scope|tenant|org|team|space|share|password|credit|billing|plan|quota/i;
const RISKY = /billing|checkout|credit|upload|download|password|token|auth|admin|member|role|share|invite|delete|export|import|webhook|url|fetch|proxy|file|key|secret|payment/i;

const splitAt = (at: string) => {
  const i = at.lastIndexOf(":");
  return { file: at.slice(0, i), line: Number(at.slice(i + 1)) };
};
const keyOf = (d: Def) => `${d.file}:${d.line}`;
const spanOf = (d: Def, cap: number): Span => ({ key: keyOf(d), name: d.name, file: d.file, start: d.line, end: Math.min(d.endLine, d.line + cap - 1) });
export const spanLines = (s: { start: number; end: number }) => s.end - s.start + 1;
const basename = (f: string) => f.split("/").pop()!;

export interface SliceDeps {
  indexer: Pick<IndexerClient, "call">;
  /** Repository file text, or undefined when it cannot be read. */
  readFile: (file: string) => Promise<string | undefined>;
}

/** Slices from the indexer's routes, cut into packets of `maxLines` unique lines. */
export async function sliceBundle(deps: SliceDeps, maxLines = BUNDLE_LIMITS.packetLines): Promise<Bundle> {
  const { indexer } = deps;
  const defsCache = new Map<string, Promise<Def[]>>();
  const defsOf = (file: string) => {
    let p = defsCache.get(file);
    if (!p) {
      p = indexer
        .call<{ definitions: Def[] }>("definitions", { path: file, limit: 5000 })
        .then((r) => r.definitions.filter((d) => d.file === file))
        .catch(() => []);
      defsCache.set(file, p);
    }
    return p;
  };
  const enclosing = async (file: string, line: number) =>
    (await defsOf(file)).filter((d) => d.line <= line && line <= d.endLine).sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
  const atDef = async (at: string) => {
    const { file, line } = splitAt(at);
    if (!file || SKIP.test(file)) return undefined;
    return (await enclosing(file, line)) ?? (await defsOf(file)).find((d) => d.line === line);
  };
  const linesCache = new Map<string, Promise<string[]>>();
  const linesOf = (f: string) => {
    let l = linesCache.get(f);
    if (!l) {
      l = deps
        .readFile(f)
        .catch(() => undefined)
        .then((text) => (text === undefined ? [] : text.split("\n")));
      linesCache.set(f, l);
    }
    return l;
  };

  /** A route with no enclosing named function (inline handler, exported const, framework config): a small
   * route file is taken whole; otherwise the handler is the bracket-balanced span from the route line
   * (indent-based for Python). */
  const inlineDef = async (at: string): Promise<Def | undefined> => {
    const { file, line } = splitAt(at);
    if (!file || SKIP.test(file)) return undefined;
    const L = await linesOf(file);
    if (!L.length) return undefined;
    if (L.length <= 400) return { name: basename(file), file, line: 1, endLine: L.length };
    let end = line;
    if (file.endsWith(".py")) {
      const indent = (t: string) => t.length - t.trimStart().length;
      const base = indent(L[line - 1] ?? "");
      for (let k = line; k < L.length; k++) {
        const t = L[k]!;
        if (t.trim() && indent(t) <= base && !/^\s*[)\]}]/.test(t)) break;
        end = k + 1;
      }
    } else {
      let depth = 0;
      let opened = false;
      for (let k = line - 1; k < L.length; k++) {
        for (const ch of L[k]!) {
          if (ch === "(" || ch === "{" || ch === "[") {
            depth++;
            opened = true;
          } else if (ch === ")" || ch === "}" || ch === "]") depth--;
        }
        end = k + 1;
        if (opened && depth <= 0) break;
      }
    }
    return { name: `${basename(file)}@${line}`, file, line, endLine: Math.max(line, end) };
  };

  // A definition's callees are asked for once, however many routes reach it.
  const calleesCache = new Map<string, Promise<Def[]>>();
  const callees = (d: Def): Promise<Def[]> => {
    const key = `${d.name}\n${keyOf(d)}`;
    let p = calleesCache.get(key);
    if (!p) calleesCache.set(key, (p = calleesOf(d)));
    return p;
  };
  const calleesOf = async (d: Def): Promise<Def[]> => {
    const r = await indexer
      .call<{ definitions: Array<{ definition: Def; calls: Array<{ call: string; definedAt: string[] }> }> }>("callees", { symbol: d.name, limit: 200 })
      .catch(() => ({ definitions: [] }));
    const mine = r.definitions.find((x) => x.definition.file === d.file && x.definition.line === d.line) ?? r.definitions[0];
    const out: Def[] = [];
    for (const call of mine?.calls ?? []) {
      const targets = call.definedAt.filter((a) => family(a.slice(0, a.lastIndexOf(":"))) === family(d.file) && !SKIP.test(a));
      if (targets.length !== 1) continue; // ambiguous names (db, eq, ...) are framework or library: skip
      const x = await atDef(targets[0]!);
      if (x && !(x.file === d.file && x.line === d.line)) out.push(x);
    }
    return out;
  };

  const routes = (await indexer.call<{ routes: RouteRow[] }>("routes", { limit: 5000 })).routes;
  // Each route is resolved against the indexer on its own, several at once: its handler, and the guard and
  // helper spans it would add, in the order it would add them. Nothing is shared between routes but caches.
  const resolved = await mapLimit(routes, BUNDLE_LIMITS.indexConcurrency, async (r) => {
    if (SKIP.test(r.at)) return undefined;
    const h = (await atDef(r.at)) ?? (await inlineDef(r.at));
    if (!h) return undefined;
    const added: Span[] = [];
    // Guards: chain entries before the handler, resolved by the indexer's "name @ file:line" handler list.
    const guards: string[] = [];
    for (const g of r.handlers ?? []) {
      const at = g.split(" @ ")[1];
      if (!at) continue;
      const gd = await atDef(at);
      if (gd && keyOf(gd) !== keyOf(h) && family(gd.file) === family(h.file)) {
        const s = spanOf(gd, 50);
        added.push(s);
        guards.push(s.key);
      }
    }
    // Helpers: 1 hop; a second hop only through auth-shaped helpers.
    const helpers: string[] = [];
    for (const d1 of await callees(h)) {
      if (!AUTHY.test(d1.name)) continue;
      const s1 = spanOf(d1, 50);
      added.push(s1);
      helpers.push(s1.key);
      for (const d2 of await callees(d1)) {
        if (!AUTHY.test(d2.name)) continue;
        const s2 = spanOf(d2, 40);
        added.push(s2);
        helpers.push(s2.key);
      }
    }
    return { r, h, added, guards, helpers };
  });

  // Put together in route order, as if each route had been resolved in turn: a handler already seen is skipped
  // with everything it would have added.
  const entries: Entry[] = [];
  const spans = new Map<string, Span>();
  const seenHandler = new Set<string>();
  for (const one of resolved) {
    if (!one || seenHandler.has(keyOf(one.h))) continue;
    const { r, h, added, guards, helpers } = one;
    seenHandler.add(keyOf(h));
    // Whole-file slices (small route files) keep every handler in the file; named handlers are capped.
    const handler = spanOf(h, h.line === 1 && h.name === basename(h.file) ? 400 : 140);
    for (const s of added) spans.set(s.key, s);
    const text = `${r.method} ${r.path} ${h.name}`;
    const risk = (r.method !== "GET" ? 1 : 0) + (RISKY.test(text) ? 1 : 0) + (helpers.length + guards.length === 0 ? 2 : 0);
    entries.push({ id: `E${entries.length + 1}`, method: r.method, path: r.path, at: r.at, handler, guards: [...new Set(guards)], helpers: [...new Set(helpers)].slice(0, 8), risk });
  }
  return cutSlicePackets(entries, spans, maxLines);
}

/** Entries in path order, cut when unique code lines (handlers plus not-yet-included shared spans) exceed `maxLines`. */
export function cutSlicePackets(entries: Entry[], spans: Map<string, Span>, maxLines = BUNDLE_LIMITS.packetLines): Bundle {
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  const packets: Packet[] = [];
  let cur: Packet = { name: "", shared: [], entries: [] };
  let lines = 0;
  let have = new Set<string>();
  for (const e of sorted) {
    const need = [...e.guards, ...e.helpers].filter((k) => !have.has(k));
    const add = spanLines(e.handler) + need.reduce((n, k) => n + spanLines(spans.get(k)!), 0);
    if (cur.entries.length && lines + add > maxLines) {
      packets.push(cur);
      cur = { name: "", shared: [], entries: [] };
      lines = 0;
      have = new Set();
    }
    for (const k of [...e.guards, ...e.helpers]) {
      if (have.has(k)) continue;
      have.add(k);
      cur.shared.push(k);
      lines += spanLines(spans.get(k)!);
    }
    cur.entries.push(e);
    lines += spanLines(e.handler);
  }
  if (cur.entries.length) packets.push(cur);
  packets.forEach((p, i) => (p.name = `B${i + 1}:${p.entries[0]!.at.split("/").slice(0, 3).join("/")}`));
  const totalLines = packets.reduce((n, p) => n + p.shared.reduce((m, k) => m + spanLines(spans.get(k)!), 0) + p.entries.reduce((m, e) => m + spanLines(e.handler), 0), 0);
  return { packets, spans: Object.fromEntries(spans), stats: { entries: sorted.length, packets: packets.length, totalLines, mode: "slices" } };
}

/** Entries in order, a new packet whenever the next one would pass `maxLines`. No shared code. */
export function cutPackets(entries: Entry[], maxLines: number, prefix: string): Packet[] {
  const groups: Entry[][] = [];
  let cur: Entry[] = [];
  let lines = 0;
  for (const e of entries) {
    const n = spanLines(e.handler);
    if (cur.length && lines + n > maxLines) {
      groups.push(cur);
      cur = [];
      lines = 0;
    }
    cur.push(e);
    lines += n;
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, i) => ({ name: `${prefix}${i + 1}`, shared: [], entries: g }));
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface WholeOptions {
  /** Total line budget, counting the base bundle's lines. */
  budget?: number;
  packetLines?: number;
  chunkLines?: number;
  /** Hybrid: keep these slices, then add whole files they do not already cover. */
  base?: Bundle;
}

/** Whole server files ranked by risk (stable for ties, in the given order), as chunk entries in packets. */
export function wholeBundle(files: Array<{ file: string; text: string }>, options: WholeOptions = {}): Bundle {
  const budget = options.budget ?? BUNDLE_LIMITS.wholeBudget;
  const per = options.packetLines ?? BUNDLE_LIMITS.packetLines;
  const chunk = options.chunkLines ?? BUNDLE_LIMITS.chunkLines;
  const base = options.base;
  const info = new Map<string, { lines: number; density: number }>();
  for (const { file, text } of files) {
    const r = riskScore(file, text);
    info.set(file, { lines: r.lines, density: r.density });
  }
  let ranked = [...info.keys()].sort((a, b) => info.get(b)!.density - info.get(a)!.density);
  let total = 0;
  if (base) {
    const covered = new Set([...base.packets.flatMap((p) => p.entries.map((e) => e.handler.file)), ...Object.values(base.spans).map((s) => s.file)]);
    ranked = ranked.filter((f) => !covered.has(f));
    total = base.stats.totalLines ?? 0;
  }
  const entries: Entry[] = [];
  for (const f of ranked) {
    const n = info.get(f)!.lines;
    for (let a = 1; a <= n; a += chunk) {
      const b = Math.min(n, a + chunk - 1);
      // Over budget: this file stops here, a smaller later file may still fit.
      if (total + (b - a + 1) > budget) break;
      entries.push({ id: `E${entries.length + 1}`, method: "FILE", path: f, at: `${f}:${a}`, handler: { key: `${f}:${a}`, name: f, file: f, start: a, end: b }, guards: [], helpers: [] });
      total += b - a + 1;
    }
  }
  entries.sort((x, y) => byCodePoint(x.at, y.at));
  const whole = cutPackets(entries, per, "W");
  if (base) {
    const packets = [...base.packets, ...whole];
    return { packets, spans: base.spans, stats: { entries: entries.length, packets: packets.length, totalLines: total, mode: "hybrid" } };
  }
  return { packets: whole, spans: {}, stats: { entries: entries.length, packets: whole.length, totalLines: total, mode: "whole" } };
}

/** Small codebases, or ones whose routes the indexer cannot map, get whole files; the rest slices plus whole files. */
export function bundleMode(serverLines: number, sliceEntries: number): Exclude<BundleMode, "slices"> {
  return serverLines <= BUNDLE_LIMITS.smallServerLines || sliceEntries < BUNDLE_LIMITS.minSliceEntries ? "whole" : "hybrid";
}

export interface PlanDeps extends SliceDeps {
  /** Tracked files of the checkout, repository-relative. */
  listFiles: () => Promise<string[]>;
}

export interface BundlePlan {
  bundle: Bundle;
  mode: Exclude<BundleMode, "slices">;
  /** Lines across all server files. */
  serverLines: number;
  /** Entries the slice bundle found (0 when the indexer failed). */
  sliceEntries: number;
}

/** The whole selection step: server files, slices, the hybrid rule. */
export async function planBundle(deps: PlanDeps): Promise<BundlePlan> {
  const listed = await deps.listFiles();
  const server = await serverFiles(listed, deps.readFile);
  const files: Array<{ file: string; text: string }> = [];
  for (const file of server) {
    const text = await deps.readFile(file).catch(() => undefined);
    if (text !== undefined) files.push({ file, text });
  }
  const serverLines = files.reduce((n, f) => n + lineCount(f.text), 0);
  const slices = await sliceBundle(deps).catch((): Bundle => ({ packets: [], spans: {}, stats: { entries: 0, packets: 0, totalLines: 0 } }));
  const mode = bundleMode(serverLines, slices.stats.entries);
  const bundle = mode === "whole" ? wholeBundle(files, { budget: BUNDLE_LIMITS.wholeBudget }) : wholeBundle(files, { budget: BUNDLE_LIMITS.hybridBudget, base: slices });
  return { bundle, mode, serverLines, sliceEntries: slices.stats.entries };
}
