/**
 * Cheap ranking of hunt candidates: no reasoning, one 0-9 number per candidate, on the same cached prefix as
 * the hunt. Used only to decide which candidates get the expensive check. Sampled 3 times.
 */
import type { Message } from "../../llm/types";
import type { Packet, Span } from "./bundle";
import type { Cluster } from "./candidates";
import { lineFields, packetPrefix, type LinesOf } from "./hunt";

export const SCORE_TASK = `Other reviewers reported the candidates below against the code above. Most are wrong. Score each 0-9 for how likely it is a real, exploitable vulnerability that harms someone other than the attacker, given the checks visible above (9 = clearly exploitable, no check blocks it; 0 = blocked or harmless). Output only lines, no prose:
C<n>|<score>`;

export const SCORE_SAMPLES = 3;
/** Candidates per call without reasoning. Unruled ones are retried once in batches of half this. */
export const SCORE_CHUNK = 40;

/** One candidate line: its cluster index and the first row's claim. */
export const candidateLine = (index: number, c: Cluster) => {
  const r = c.rows[0]!;
  return `C${index}|${r.entry_id}|${r.kind}|${r.attacker}|${r.sink_file}:${r.sink_line}|${r.victim}|${r.why}`;
};

/** The scoring call for some of a packet's candidates: the hunt's prefix, then the task, then the list. */
export function scoreMessages(packet: Packet, spans: Record<string, Span>, lines: LinesOf, clusters: Cluster[], ids: number[]): Message[] {
  const list = ids.map((i) => candidateLine(i, clusters[i]!)).join("\n");
  return [{ role: "user", content: `${packetPrefix(packet, spans, lines)}\n\n${SCORE_TASK}\n\nCandidates:\n${list}` }];
}

/** Scores from a reply: every `C<n>|...` line, its last field read as an integer (0 when it is not one). */
export function parseScoreReply(text: string): Array<{ index: number; score: number }> {
  const out: Array<{ index: number; score: number }> = [];
  for (const raw of text.split("\n")) {
    const f = lineFields(raw);
    const m = f[0]?.match(/^C(\d+)$/);
    if (!m) continue;
    out.push({ index: Number(m[1]), score: Number.parseInt(f[f.length - 1] ?? "0", 10) || 0 });
  }
  return out;
}

/** Score votes per cluster index, as stored: each vote a decimal string. */
export type ScoreVotes = Record<string, { votes: Array<string | number> } | undefined>;

/** Adds a reply's scores to the running votes. */
export function addVotes(votes: Record<number, string[]>, scores: Array<{ index: number; score: number }>): void {
  for (const s of scores) (votes[s.index] ??= []).push(String(s.score));
}

export const toScoreVotes = (votes: Record<number, string[]>): ScoreVotes => Object.fromEntries(Object.entries(votes).map(([i, v]) => [i, { votes: v }]));

export interface ScoreBatch {
  packet: string;
  ids: number[];
}

/** Clusters grouped by their first row's packet (in first-seen order), in batches of `chunk`. */
export function scoreBatches(clusters: Cluster[], chunk = SCORE_CHUNK): ScoreBatch[] {
  const byPacket = new Map<string, number[]>();
  clusters.forEach((c, i) => {
    const p = String(c.rows[0]!.packet);
    byPacket.set(p, [...(byPacket.get(p) ?? []), i]);
  });
  return [...byPacket.entries()].flatMap(([packet, ids]) => batch(ids, chunk).map((b) => ({ packet, ids: b })));
}

/** The one retry: clusters with no vote yet, in batches of half the chunk. */
export function retryBatches(clusters: Cluster[], votes: Record<number, string[]>, chunk = SCORE_CHUNK): ScoreBatch[] {
  const missing = scoreBatches(clusters, Number.MAX_SAFE_INTEGER)
    .map(({ packet, ids }) => ({ packet, ids: ids.filter((i) => !votes[i]) }))
    .filter((b) => b.ids.length);
  return missing.flatMap(({ packet, ids }) => batch(ids, Math.max(1, Math.floor(chunk / 2))).map((b) => ({ packet, ids: b })));
}

const batch = (ids: number[], n: number) => Array.from({ length: Math.ceil(ids.length / n) }, (_, k) => ids.slice(k * n, k * n + n));
