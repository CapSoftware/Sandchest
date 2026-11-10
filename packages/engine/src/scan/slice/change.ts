/**
 * The cheap pipeline on one pull request or commit: packets from the changed server files (whole when short,
 * otherwise the regions around the changed hunks), and candidates on changed lines first.
 */
import { cutPackets, type Bundle, type Entry } from "./bundle";
import { mergeInOrder, orderBy, votesOf, type Candidate, type Cluster } from "./candidates";
import type { ScoreVotes } from "./score";
import { isServerFile } from "./source";

export type Range = [number, number];

export const CHANGE_LIMITS = {
  /** A changed file at most this long is shown whole. */
  wholeFileLines: 500,
  /** Context kept on each side of a hunk in a longer file. */
  context: 120,
  /** Longest region; longer ones are split. */
  regionLines: 500,
  packetLines: 1_800,
  /** A candidate counts as in the diff within this many lines of a hunk. */
  nearHunk: 8,
  /** Candidates handed to the verifier. */
  topK: 12,
  /** Candidates whose best score is below this are dropped. */
  minScore: 2,
};

/** `git diff --numstat` rows; binary files (`-`) are left out. */
export function parseNumstat(text: string): Array<{ path: string; additions: number; deletions: number }> {
  const out: Array<{ path: string; additions: number; deletions: number }> = [];
  for (const l of text.trim().split("\n")) {
    const p = l.split("\t");
    if (p.length === 3 && p[0] !== "-") out.push({ path: p[2]!, additions: Number.parseInt(p[0]!, 10), deletions: Number.parseInt(p[1]!, 10) });
  }
  return out;
}

/** Changed server files that add lines, in the given order (a .tsx/.jsx outside the Next.js server shapes never counts). */
export const changedServerPaths = (files: Array<{ path: string; additions: number }>) => files.filter((f) => isServerFile(f.path) && f.additions > 0).map((f) => f.path);

/** New-side line ranges of each file's hunks, from a `git diff -U0`; pure deletions are left out. */
export function parseDiffHunks(diff: string): Map<string, Range[]> {
  const hunks = new Map<string, Range[]>();
  let cur: string | undefined;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ b/")) cur = l.slice(6);
    const m = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (m && cur) {
      const a = Number(m[1]);
      const n = Number(m[2] ?? "1");
      if (n > 0) hunks.set(cur, [...(hunks.get(cur) ?? []), [a, a + n - 1]]);
    }
  }
  return hunks;
}

const byRange = (x: Range, y: Range) => x[0] - y[0] || x[1] - y[1];

/** Regions of a changed file to show: the whole file when short, otherwise each hunk +-context, merged and capped. */
export function changeRegions(lineTotal: number, hunks: Range[]): Range[] {
  if (lineTotal <= CHANGE_LIMITS.wholeFileLines) return [[1, lineTotal]];
  const spans: Range[] = [];
  for (const [a, b] of [...hunks].sort(byRange)) {
    const s = Math.max(1, a - CHANGE_LIMITS.context);
    const e = Math.min(lineTotal, b + CHANGE_LIMITS.context);
    const last = spans[spans.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else spans.push([s, e]);
  }
  const out: Range[] = [];
  for (const [s0, e] of spans) {
    let s = s0;
    while (e - s + 1 > CHANGE_LIMITS.regionLines) {
      out.push([s, s + CHANGE_LIMITS.regionLines - 1]);
      s += CHANGE_LIMITS.regionLines;
    }
    out.push([s, e]);
  }
  return out;
}

export interface ChangeBundle {
  bundle: Bundle;
  /** Changed ranges per file, for `inDiff`. */
  hunks: Map<string, Range[]>;
}

/** Packets for a change: one entry per region with changed lines, headed by those ranges. */
export function changeBundle(files: Array<{ file: string; text: string; hunks: Range[] }>): ChangeBundle {
  const entries: Entry[] = [];
  const hunks = new Map<string, Range[]>();
  let total = 0;
  for (const { file: f, text, hunks: raw } of files) {
    if (!raw.length) continue;
    hunks.set(f, raw);
    const n = (text.match(/\n/g)?.length ?? 0) + 1;
    const hs = [...raw].sort(byRange);
    for (const [s, e] of changeRegions(n, hs)) {
      const ch = hs.filter(([a, b]) => b >= s && a <= e);
      if (!ch.length) continue;
      const rng = ch
        .slice(0, 12)
        .map(([a, b]) => (a !== b ? `${Math.max(a, s)}-${Math.min(b, e)}` : String(a)))
        .join(", ");
      entries.push({ id: `E${entries.length + 1}`, method: "CHANGED", path: `${f} (changed lines: ${rng})`, at: `${f}:${s}`, handler: { key: `${f}:${s}`, name: f, file: f, start: s, end: e }, guards: [], helpers: [], hunks: ch });
      total += e - s + 1;
    }
  }
  const packets = cutPackets(entries, CHANGE_LIMITS.packetLines, "P");
  return { bundle: { packets, spans: {}, stats: { entries: entries.length, packets: packets.length, totalLines: total } }, hunks };
}

/** Whether any of a cluster's rows cites a line within 8 lines of a changed range. */
export const inDiff = (c: Pick<Cluster, "rows">, hunks: Map<string, Range[]>) =>
  c.rows.some((r) => (hunks.get(r.sink_file) ?? []).some(([a, b]) => a - CHANGE_LIMITS.nearHunk <= r.sink_line && r.sink_line <= b + CHANGE_LIMITS.nearHunk));

export interface ChangeCandidate extends Candidate {
  inDiff: boolean;
}

/** Deduped candidates (on changed lines first, then by score), and the first `k` in the diff with a best score of at least 2. */
export function changeCandidates(clusters: Cluster[], scores: ScoreVotes, hunks: Map<string, Range[]>, k = CHANGE_LIMITS.topK): { kept: ChangeCandidate[]; selected: number[] } {
  const near = clusters.map((c) => inDiff(c, hunks));
  const order = orderBy(
    clusters.map((_, i) => i),
    (i) => {
      const v = votesOf(scores, i);
      return [near[i] ? 1 : 0, Math.max(...v), v.reduce((n, x) => n + x, 0), clusters[i]!.rows.length];
    },
  );
  const kept = mergeInOrder(clusters, order, scores).map((c) => ({ ...c, inDiff: near[c.orig]! }));
  const selected = kept
    .map((c, i) => [c, i] as const)
    .filter(([c]) => c.inDiff && Math.max(...c.a) >= CHANGE_LIMITS.minScore)
    .slice(0, k)
    .map(([, i]) => i);
  return { kept, selected };
}
