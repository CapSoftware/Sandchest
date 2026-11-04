/**
 * Evidence gate. A candidate survives only if every location it cites is a
 * real line in the checkout, and it is not a repeat of one already reported.
 * The schema has already required an entry point, a path, preconditions, a
 * proof of concept and an impact.
 */
import { createHash } from "node:crypto";
import type { IndexerClient } from "../indexer/client";
import type { Candidate, Category } from "./schema";

export interface Located {
  file: string;
  line: number;
  text: string;
  /** Enclosing function or class, if any. */
  symbol: string | null;
}

export interface GatedCandidate {
  id: string;
  candidate: Candidate;
  entry: Located;
  path: Located[];
  fingerprint: string;
  /** Which hunter reported it. */
  hunter: string;
  /** On a re-check after a push: what the push changed (unified diff), so the reviewer can see whether it is the fix. */
  recheck?: string;
}

interface LocateResult {
  locations: Array<{ file: string; line: number; exists: boolean; text?: string; symbol?: string | null; totalLines?: number }>;
}

export type GateResult = { ok: true; entry: Located; path: Located[] } | { ok: false; problems: string[] };

/** Checks that every cited `file:line` exists and that the sink line holds code. */
export async function checkEvidence(indexer: IndexerClient, candidate: Candidate, signal?: AbortSignal): Promise<GateResult> {
  const cited = [candidate.entryPoint, ...candidate.path].map(({ file, line }) => ({ file: normalizePath(file), line }));
  const { locations } = await indexer.call<LocateResult>("locate", { locations: cited }, signal);

  const problems: string[] = [];
  for (const location of locations) {
    if (!location.exists) {
      problems.push(
        location.totalLines === undefined
          ? `${location.file} does not exist in the repository.`
          : `${location.file}:${location.line} is past the end of the file (${location.totalLines} lines).`,
      );
    }
  }
  const sink = locations.at(-1);
  if (sink?.exists && !sink.text?.trim()) {
    problems.push(`${sink.file}:${sink.line} is a blank line; cite the line that holds the sink or the missing check.`);
  }
  if (problems.length > 0) return { ok: false, problems };

  const [entry, ...path] = locations.map((l) => ({ file: l.file, line: l.line, text: l.text ?? "", symbol: l.symbol ?? null }));
  return { ok: true, entry: entry!, path };
}

/**
 * Stable identity across scans: rule class plus the normalised sink — its
 * file, enclosing function and code — so moving code around does not change
 * it, while a second bug in the same function does.
 */
export function fingerprint(category: Category, sink: Located): string {
  const code = sink.text.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${category}\n${sink.file}\n${sink.symbol ?? ""}\n${code}`).digest("hex").slice(0, 16);
}

/**
 * Remembers reported candidates so parallel hunters do not report the same
 * bug twice. Two reports of the same class match when they share a
 * fingerprint, a sink (nearby lines in one function), an entry point, or
 * most of their path, or explain the same vulnerable-dependency lead.
 * Access-control classes count as one: hunters label
 * the same missing check as IDOR, privilege escalation or mass assignment.
 */
export class CandidateRegistry {
  private readonly accepted: GatedCandidate[] = [];

  find(category: Category, entry: Located, path: Located[], print: string, leads: string[] = []): GatedCandidate | undefined {
    const sink = path.at(-1)!;
    return this.accepted.find((other) => {
      if (other.fingerprint === print) return true;
      if (family(other.candidate.category) !== family(category)) return false;
      const otherSink = other.path.at(-1)!;
      const sameSink = otherSink.file === sink.file && otherSink.symbol === sink.symbol && Math.abs(otherSink.line - sink.line) <= 3;
      // Entry points match exactly: routes registered on adjacent lines are different routes.
      const sameEntry = other.entry.file === entry.file && other.entry.line === entry.line;
      const sameLead = category === "vulnerable_dependency" && (other.candidate.leads ?? []).some((id) => leads.includes(id));
      return sameSink || sameEntry || sameLead || overlap(other.path, path) >= 0.5;
    });
  }

  add(candidate: GatedCandidate): void {
    this.accepted.push(candidate);
  }

  /** Every location an accepted candidate cites. */
  cited(): Array<{ file: string; line: number }> {
    return this.accepted.flatMap((candidate) => [candidate.entry, ...candidate.path]);
  }

  get size(): number {
    return this.accepted.length;
  }
}

const ACCESS_CONTROL = new Set<Category>(["broken_access_control", "privilege_escalation", "mass_assignment"]);

function family(category: Category): string {
  return ACCESS_CONTROL.has(category) ? "access_control" : category;
}

function near(a: Located, b: Located): boolean {
  return a.file === b.file && Math.abs(a.line - b.line) <= 2;
}

/** Share of the shorter path's hops that also appear in the other path. */
function overlap(a: Located[], b: Located[]): number {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const shared = shorter.filter((hop) => longer.some((other) => near(hop, other))).length;
  return shared / shorter.length;
}

export function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, "").replace(/^\/+/, "");
}

/** A finding as stored after a scan: enough to recognise the same bug when a later scan reports it. */
export interface KnownFinding {
  fingerprint: string;
  category: string;
  entryPoint: { file: string; line: number };
  attackPath: Array<{ file: string; line: number }>;
  /** Other reports folded into this finding (`file:line` of their sink and entry). */
  alsoReportedAs?: Array<{ category: string; at: string; entry: string }>;
}

/**
 * Whether two reports describe the same bug, by the registry's rules for
 * one scan: same class family, and the same sink (same file, within three
 * lines), the same entry point, or most of the same path. Stored findings
 * have no enclosing function, so the sink match is by file and line only.
 */
export function sameBug(a: KnownFinding, b: KnownFinding): boolean {
  if (sameReport(a, b)) return true;
  // A merged finding is also each report it absorbed: match those by sink or entry.
  const views = (k: KnownFinding) => [
    { category: k.category, sink: k.attackPath.at(-1), entry: k.entryPoint },
    ...(k.alsoReportedAs ?? []).map((r) => ({ category: r.category, sink: location(r.at), entry: location(r.entry) })),
  ];
  if (!a.alsoReportedAs?.length && !b.alsoReportedAs?.length) return false;
  return views(a).some((x) =>
    views(b).some(
      (y) =>
        family(x.category as Category) === family(y.category as Category) &&
        ((!!x.sink && !!y.sink && x.sink.file === y.sink.file && Math.abs(x.sink.line - y.sink.line) <= 3) || (x.entry.file === y.entry.file && x.entry.line === y.entry.line)),
    ),
  );
}

function location(at: string): { file: string; line: number } {
  const colon = at.lastIndexOf(":");
  return colon === -1 ? { file: at, line: 0 } : { file: at.slice(0, colon), line: Number(at.slice(colon + 1)) || 0 };
}

function sameReport(a: KnownFinding, b: KnownFinding): boolean {
  if (family(a.category as Category) !== family(b.category as Category)) return false;
  const sinkA = a.attackPath.at(-1);
  const sinkB = b.attackPath.at(-1);
  if (!sinkA || !sinkB) return false;
  if (sinkA.file === sinkB.file && Math.abs(sinkA.line - sinkB.line) <= 3) return true;
  if (a.entryPoint.file === b.entryPoint.file && a.entryPoint.line === b.entryPoint.line) return true;
  const [shorter, longer] = a.attackPath.length <= b.attackPath.length ? [a.attackPath, b.attackPath] : [b.attackPath, a.attackPath];
  const shared = shorter.filter((hop) => longer.some((other) => hop.file === other.file && Math.abs(hop.line - other.line) <= 2)).length;
  return shared / shorter.length >= 0.5;
}

/**
 * Gives each new finding the fingerprint of the stored finding it repeats,
 * so a rescan updates the existing finding (and keeps the team's verdict on
 * it) instead of filing the same bug again. The fingerprint alone misses
 * this: it keys on the sink and its function, and hunters cite a different
 * last hop from one scan to the next. Exact fingerprint matches are kept; a
 * stored finding is adopted by at most one new finding per scan.
 */
export function adoptKnownFingerprints<T extends KnownFinding>(findings: T[], known: KnownFinding[]): T[] {
  const taken = new Set(findings.map((f) => f.fingerprint).filter((print) => known.some((k) => k.fingerprint === print)));
  return findings.map((finding) => {
    if (taken.has(finding.fingerprint)) return finding;
    const match = known.find((k) => !taken.has(k.fingerprint) && sameBug(k, finding));
    if (!match) return finding;
    taken.add(match.fingerprint);
    return { ...finding, fingerprint: match.fingerprint };
  });
}
