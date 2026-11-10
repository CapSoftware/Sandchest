/**
 * From hunt rows to a short ranked list: cluster rows by location, dedupe clusters that name the same weakness
 * near the same line (best-scored first), then take the top K by interleaving two orders, score alone and score
 * plus deviance, so neither signal alone decides what is checked.
 */
import type { HuntRow } from "./hunt";
import type { ScoreVotes } from "./score";

export interface Cluster {
  /** The first row's anchor; later rows join when they land within 10 lines of it. */
  file: string;
  line: number;
  rows: HuntRow[];
}

export interface Candidate {
  /** The cluster that was kept; `rows[0]` is the representative. */
  rows: HuntRow[];
  /** Its rows plus every merged cluster's rows. */
  merged: HuntRow[];
  /** Index of the kept cluster in the cluster list. */
  orig: number;
  /** Score votes of the kept cluster. */
  a: number[];
}

/** Deviance features of a candidate's function, keyed by candidate index in the input. */
export type DevianceInput = Record<string, { dev?: number | null; noAuth?: boolean | null; sibAuthShare?: number | null } | undefined>;

/** An integer the way a strict integer parse reads it; undefined when the value is not one. */
function toInt(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : undefined;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10);
  return undefined;
}

/** A row's locations: entry then sink, each when both parts are present; leading `.` and `/` stripped from the path. */
export function spots(row: Partial<Record<keyof HuntRow, unknown>>): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  for (const [fk, lk] of [
    ["file", "line"],
    ["sink_file", "sink_line"],
  ] as const) {
    if (!row[fk] || !row[lk]) continue;
    const line = toInt(row[lk]);
    if (line !== undefined) out.push([String(row[fk]).replace(/^[./]+/, ""), line]);
  }
  return out;
}

/** Groups rows by their last location (the sink when present): same file within 10 lines of a cluster's first row.
 * Most-agreed first: clusters reported by more distinct passes lead; ties keep first-seen order. */
export function cluster(rows: HuntRow[]): Cluster[] {
  const cs: Cluster[] = [];
  for (const r of rows) {
    const sp = spots(r);
    if (!sp.length) continue;
    const [f, l] = sp[sp.length - 1]!;
    const c = cs.find((x) => x.file === f && Math.abs(x.line - l) <= 10);
    if (c) c.rows.push(r);
    else cs.push({ file: f, line: l, rows: [r] });
  }
  const passes = (c: Cluster) => new Set(c.rows.map((r) => r.pass)).size;
  return cs.sort((a, b) => passes(b) - passes(a));
}

/** Kind family for dedupe: injection, SSRF, XSS, everything else is access control. */
export function normKind(kind: string | undefined | null): "sqli" | "ssrf" | "xss" | "authz" {
  const k = (kind ?? "").toLowerCase();
  return k.includes("sql") || k.includes("inject") ? "sqli" : k.includes("ssrf") ? "ssrf" : k.includes("xss") ? "xss" : "authz";
}

/** Score votes of cluster `i`, as integers; a cluster with none has a single 0. */
export function votesOf(scores: ScoreVotes, i: number): number[] {
  const v = scores[String(i)]?.votes;
  const ints = (v && v.length ? v : ["0"]).map((x) => toInt(x) ?? 0);
  return ints;
}

const max = (a: number[]) => Math.max(...a);
const sum = (a: number[]) => a.reduce((n, x) => n + x, 0);

/** Walks clusters in `order`, merging each into an earlier kept one with the same sink file and kind family
 * within 40 lines of its representative. */
export function mergeInOrder(clusters: Cluster[], order: number[], scores: ScoreVotes): Candidate[] {
  const kept: Candidate[] = [];
  for (const i of order) {
    const r = clusters[i]!.rows[0]!;
    const m = kept.find((k) => k.rows[0]!.sink_file === r.sink_file && normKind(k.rows[0]!.kind) === normKind(r.kind) && Math.abs(k.rows[0]!.sink_line - r.sink_line) <= 40);
    if (m) {
      m.merged.push(...clusters[i]!.rows);
      continue;
    }
    kept.push({ rows: clusters[i]!.rows, merged: [...clusters[i]!.rows], orig: i, a: votesOf(scores, i) });
  }
  return kept;
}

/** Descending by each key in turn; ties keep input order. */
export function orderBy<T>(items: T[], key: (x: T) => number[]): T[] {
  const keys = new Map(items.map((x) => [x, key(x)]));
  return [...items].sort((x, y) => {
    const a = keys.get(x)!;
    const b = keys.get(y)!;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return b[k]! - a[k]!;
    return 0;
  });
}

/** Clusters best-scored first (max vote, vote total, rows), with near repeats merged into the first. */
export function dedupe(clusters: Cluster[], scores: ScoreVotes): Candidate[] {
  const idx = clusters.map((_, i) => i);
  const order = orderBy(idx, (i) => {
    const v = votesOf(scores, i);
    return [max(v), sum(v), clusters[i]!.rows.length];
  });
  return mergeInOrder(clusters, order, scores);
}

/** Candidates one verification session rules on: a band of the ranking. */
export const TOP_K = 30;
/** Bands a whole-repository hunt selects, each verified by a session of its own. */
export const TOP_BANDS = 2;

/**
 * The top `k` candidate indices: alternately the next best by score (max, mean, log of merged rows) and by
 * score plus deviance (max + 3 x deviance + 1.5 x share of siblings with auth when this one has none, then
 * mean), skipping any already taken.
 */
export function topK(kept: Candidate[], deviance: DevianceInput, k = TOP_K, skip: ReadonlySet<number> = new Set()): number[] {
  const byScore = (i: number) => {
    const a = kept[i]!.a;
    return [max(a), sum(a) / a.length, Math.log(1 + kept[i]!.merged.length)];
  };
  const byDeviance = (i: number) => {
    const a = kept[i]!.a;
    const x = deviance[String(i)] ?? {};
    return [max(a) + 3 * (x.dev || 0) + 1.5 * (x.noAuth ? 1 : 0) * (x.sibAuthShare || 0), sum(a) / a.length];
  };
  const idx = kept.map((_, i) => i).filter((i) => !skip.has(i));
  const lists = [orderBy(idx, byScore), orderBy(idx, byDeviance)];
  const out: number[] = [];
  const seen = new Set<number>();
  for (let n = 0; out.length < k && n < idx.length; n++) {
    for (const list of lists) {
      if (out.length < k && !seen.has(list[n]!)) {
        seen.add(list[n]!);
        out.push(list[n]!);
      }
    }
  }
  return out;
}
