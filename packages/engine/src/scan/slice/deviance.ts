/**
 * Deviance features for ranking candidates ("bugs as deviant behaviour"): a handler that skips an
 * authorization-shaped call most of its siblings make is the classic shape of a real access-control bug.
 * Language-agnostic: functions come from the indexer's definitions, auth calls from identifier text.
 */
import { posix } from "node:path";
import { BUNDLE_LIMITS, mapLimit } from "./bundle";
import type { Candidate } from "./candidates";

export interface DevDef {
  name: string;
  file: string;
  line: number;
  endLine: number;
}

export interface DevianceFeatures {
  /** `name@file:line` of the function around the candidate's sink, or null when there is none. */
  fn: string | null;
  lines?: number;
  /** Auth-shaped identifiers this function uses (first 12). */
  auth?: string[];
  sibs?: number;
  /** Share of siblings that use any auth-shaped identifier, to 2 decimals. */
  sibAuthShare?: number;
  noAuth?: boolean;
  /** Share of siblings using the most common auth identifier this function lacks (if at least half do), to 2 decimals. */
  dev?: number;
  missing?: string[];
  /** The function writes something. */
  mut?: boolean;
}

export interface DevianceDeps {
  /** Definitions in `file` (only those whose `file` matches are used). */
  definitions: (file: string) => Promise<DevDef[]>;
  /** File text split into lines; [] when unreadable. */
  lines: (file: string) => Promise<string[]>;
  /** Entry names in a directory, in listing order; [] when unreadable. */
  listDir: (dir: string) => Promise<string[]>;
}

const AUTH = /(authori[sz]e|authenticat|permission|polic|^can[A-Z_]|^can$|^is_?(admin|owner|member|manager|staff|super)|require|ensure|guard|verify|check_?access|owner|member|role|access|allowed|forbid|unauthori|admin|scope|tenant|belongs|visible|readable|writable|manage)/i;
const MUT = /\b(insert|update|delete|destroy|remove|save|create|set[A-Z_]|write|put|post|patch|grant|revoke|transfer|charge|refund|upload)\w*\s*\(/i;

const size = (d: DevDef) => d.endLine - d.line;

/** Functions not nested in a larger (under 400 lines) function of the same file, and at least 3 lines long. */
export const topLevel = (ds: DevDef[]) => ds.filter((d) => size(d) >= 2 && !ds.some((o) => o !== d && o.line <= d.line && d.endLine <= o.endLine && size(o) > size(d) && size(o) < 400));

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Memoises the deps per call so each file is read and indexed once. */
function cached(deps: DevianceDeps): DevianceDeps {
  const defs = new Map<string, Promise<DevDef[]>>();
  const text = new Map<string, Promise<string[]>>();
  return {
    definitions: (f) => {
      let p = defs.get(f);
      if (!p) {
        p = deps
          .definitions(f)
          .then((ds) => ds.filter((d) => d.file === f))
          .catch(() => []);
        defs.set(f, p);
      }
      return p;
    },
    lines: (f) => {
      let p = text.get(f);
      if (!p) {
        p = deps.lines(f).catch(() => []);
        text.set(f, p);
      }
      return p;
    },
    listDir: (d) => deps.listDir(d).catch(() => []),
  };
}

/** Deviance features of the function around each location. */
export async function devianceOf(targets: Array<{ file: string; line: number }>, rawDeps: DevianceDeps): Promise<DevianceFeatures[]> {
  const deps = cached(rawDeps);
  const authOf = async (d: DevDef) => {
    const body = (await deps.lines(d.file)).slice(d.line - 1, d.endLine).join("\n");
    const ids = new Set(body.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
    ids.delete(d.name);
    return { auth: [...ids].filter((t) => t.length > 3 && AUTH.test(t)), mut: MUT.test(body) };
  };
  const siblings = async (d: DevDef): Promise<DevDef[]> => {
    const same = topLevel(await deps.definitions(d.file)).filter((x) => x.line !== d.line);
    if (same.length >= 3) return same.slice(0, 60);
    // One handler per file (server actions, route files): siblings are the largest functions of the files beside it.
    const dir = posix.dirname(d.file);
    const own = d.file.split("/").pop();
    const files = (await deps.listDir(dir)).filter((f) => /\.\w+$/.test(f) && f !== own).slice(0, 40);
    const out: DevDef[] = [...same];
    for (const f of files) {
      const ds = topLevel(await deps.definitions(posix.join(dir, f)));
      const big = ds.sort((a, b) => size(b) - size(a))[0];
      if (big) out.push(big);
    }
    return out;
  };

  // Each location on its own, several at once: nothing is shared between them but the caches above.
  return mapLimit(targets, BUNDLE_LIMITS.indexConcurrency, async ({ file, line }): Promise<DevianceFeatures> => {
    const ds = await deps.definitions(file);
    const d = ds.filter((x) => x.line <= line && line <= x.endLine && size(x) < 400).sort((a, b) => size(a) - size(b))[0];
    if (!d) return { fn: null };
    const me = await authOf(d);
    const sibs = await siblings(d);
    const sa: Array<{ auth: string[]; mut: boolean }> = [];
    for (const s of sibs) sa.push(await authOf(s));
    // Tokens most siblings use: the share of siblings using each, for those this function lacks.
    const freq = new Map<string, number>();
    for (const s of sa) for (const t of new Set(s.auth)) freq.set(t, (freq.get(t) ?? 0) + 1);
    const mine = new Set(me.auth);
    const missing = [...freq.entries()].filter(([t, n]) => !mine.has(t) && n / Math.max(1, sibs.length) >= 0.5).sort((a, b) => b[1] - a[1]);
    const sibAuthShare = sa.filter((s) => s.auth.length > 0).length / Math.max(1, sibs.length);
    return {
      fn: `${d.name}@${d.file}:${d.line}`,
      lines: d.endLine - d.line + 1,
      auth: me.auth.slice(0, 12),
      sibs: sibs.length,
      sibAuthShare: round2(sibAuthShare),
      noAuth: me.auth.length === 0,
      dev: missing.length ? round2(missing[0]![1] / Math.max(1, sibs.length)) : 0,
      missing: missing.slice(0, 5).map(([t]) => t),
      mut: me.mut,
    };
  });
}

/** Deviance input for `topK`: features of each candidate's representative sink, keyed by candidate index. */
export async function candidateDeviance(kept: Candidate[], deps: DevianceDeps): Promise<Record<string, DevianceFeatures>> {
  const features = await devianceOf(
    kept.map((c) => ({ file: c.rows[0]!.sink_file, line: c.rows[0]!.sink_line })),
    deps,
  );
  return Object.fromEntries(features.map((f, i) => [String(i), f]));
}
