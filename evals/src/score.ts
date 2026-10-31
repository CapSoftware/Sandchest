/**
 * Scores a scan against a benchmark.
 *
 * A finding matches an expected vulnerability when one of its cited lines
 * (entry point or any hop) falls within an expected location, give or take
 * a few lines, and it names the same class (category or CWE). Committed
 * secrets also count when a secret lead lands on the location.
 *
 * Precision is over the findings the product shows by default: high and
 * critical, excluding low confidence. Findings that match nothing are false
 * positives if they land on a decoy or a human judged them so; otherwise
 * they wait for judgement, and precision is reported as a range.
 */
import type { Finding, Lead, ScanReport } from "@sandchest/engine/scan";
import type { Benchmark, CodeRange, ExpectedFinding } from "./benchmark";

/** Lines of slack either side of an expected location. */
export const TOLERANCE = 5;

export type Judgement = "real" | "false_positive";
/** Human judgements by finding fingerprint. Fingerprints are stable across scans, so judgements carry over. */
export type Judgements = Record<string, Judgement>;

export interface FindingScore {
  fingerprint: string;
  title: string;
  severity: Finding["severity"];
  confidence: Finding["confidence"];
  at: string;
  /** Expected ids this finding matches. */
  matches: string[];
  verdict: "true_positive" | "false_positive" | "unjudged";
  /** Why it was ruled a false positive, if it was. */
  reason?: "decoy" | "judged";
}

export interface BenchmarkScore {
  name: string;
  kind: Benchmark["kind"];
  expected: { total: number; serious: number };
  found: { total: number; serious: number };
  missed: Array<Pick<ExpectedFinding, "id" | "title" | "severity">>;
  /** Shown findings: high or critical, not low confidence. */
  shown: { total: number; truePositives: number; falsePositives: number; unjudged: number };
  /** Recall over critical and high expected findings. */
  recall: number | null;
  recallAll: number | null;
  /** Precision with unjudged findings counted as false (lower bound) and left out (known). */
  precision: { lower: number | null; known: number | null };
  findings: FindingScore[];
}

const SERIOUS = new Set(["critical", "high"]);

export function score(benchmark: Benchmark, report: ScanReport, judgements: Judgements = {}): BenchmarkScore {
  const found = new Set<string>();
  const findings: FindingScore[] = report.findings.map((finding) => {
    const matches = benchmark.expected.filter((expected) => matchesFinding(expected, finding)).map((expected) => expected.id);
    matches.forEach((id) => found.add(id));
    const sink = finding.attackPath.at(-1)!;
    const decoy = benchmark.decoys.some((range) => within(range, sink.file, sink.line, 0));
    const judged = judgements[finding.fingerprint];
    let verdict: FindingScore["verdict"] = "unjudged";
    let reason: FindingScore["reason"];
    if (matches.length > 0 || judged === "real") verdict = "true_positive";
    else if (decoy || judged === "false_positive") {
      verdict = "false_positive";
      reason = decoy ? "decoy" : "judged";
    }
    return {
      fingerprint: finding.fingerprint,
      title: finding.title,
      severity: finding.severity,
      confidence: finding.confidence,
      at: `${sink.file}:${sink.line}`,
      matches,
      verdict,
      reason,
    };
  });

  for (const expected of benchmark.expected) {
    if (expected.category === "hardcoded_secret" && report.leads.some((lead) => matchesSecretLead(expected, lead))) found.add(expected.id);
  }

  const serious = benchmark.expected.filter((e) => SERIOUS.has(e.severity));
  const shown = findings.filter((f) => SERIOUS.has(f.severity) && f.confidence !== "low");
  const truePositives = shown.filter((f) => f.verdict === "true_positive").length;
  const falsePositives = shown.filter((f) => f.verdict === "false_positive").length;
  const unjudged = shown.length - truePositives - falsePositives;

  return {
    name: benchmark.name,
    kind: benchmark.kind,
    expected: { total: benchmark.expected.length, serious: serious.length },
    found: { total: found.size, serious: serious.filter((e) => found.has(e.id)).length },
    missed: benchmark.expected.filter((e) => !found.has(e.id)).map(({ id, title, severity }) => ({ id, title, severity })),
    shown: { total: shown.length, truePositives, falsePositives, unjudged },
    recall: ratio(serious.filter((e) => found.has(e.id)).length, serious.length),
    recallAll: ratio(found.size, benchmark.expected.length),
    precision: { lower: ratio(truePositives, shown.length), known: ratio(truePositives, truePositives + falsePositives) },
    findings,
  };
}

function matchesFinding(expected: ExpectedFinding, finding: Finding): boolean {
  const sameClass = finding.category === expected.category || (finding.cwe !== null && expected.cwe.includes(finding.cwe));
  if (!sameClass) return false;
  const cited = [finding.entryPoint, ...finding.attackPath];
  return cited.some(({ file, line }) => expected.locations.some((range) => within(range, file, line, TOLERANCE)));
}

function matchesSecretLead(expected: ExpectedFinding, lead: Lead): boolean {
  if (lead.kind !== "secret" || !lead.at) return false;
  const split = lead.at.lastIndexOf(":");
  const file = lead.at.slice(0, split);
  const line = Number(lead.at.slice(split + 1));
  return expected.locations.some((range) => within(range, file, line, TOLERANCE));
}

function within(range: CodeRange, file: string, line: number, tolerance: number): boolean {
  return range.file === file && line >= range.startLine - tolerance && line <= range.endLine + tolerance;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export interface Aggregate {
  recall: number | null;
  precision: { lower: number | null; known: number | null };
  unjudged: number;
}

/** Pools counts across benchmarks rather than averaging ratios, so big benchmarks weigh more. */
export function aggregate(scores: BenchmarkScore[]): Aggregate {
  const vulnerable = scores.filter((s) => s.kind === "vulnerable");
  const expected = vulnerable.reduce((sum, s) => sum + s.expected.serious, 0);
  const found = vulnerable.reduce((sum, s) => sum + s.found.serious, 0);
  const shown = scores.reduce((sum, s) => sum + s.shown.total, 0);
  const tp = scores.reduce((sum, s) => sum + s.shown.truePositives, 0);
  const fp = scores.reduce((sum, s) => sum + s.shown.falsePositives, 0);
  return {
    recall: ratio(found, expected),
    precision: { lower: ratio(tp, shown), known: ratio(tp, tp + fp) },
    unjudged: shown - tp - fp,
  };
}
