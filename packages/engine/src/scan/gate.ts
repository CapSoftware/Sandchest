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
