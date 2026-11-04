/**
 * Scores a scan against a benchmark.
 *
 * A finding matches an expected vulnerability when one of its cited lines
 * (entry point or any hop) falls within an expected location, give or take
 * a few lines, and it names the same class (category or CWE). Committed
 * secrets also count when a secret lead lands on the location.
 *
 * Findings are taken in report order. The first to land on an expected
 * bug's location is its true positive; later ones on the same location are
 * duplicates (a bug with three vulnerable copies, listed as three locations,
 * can be reported three times without duplicates). A duplicate is noise to the reader, so it is
 * counted apart from precision and reported as the duplicate rate.
 *
 * Precision is over unique findings the product shows by default: high and
 * critical, excluding low confidence. Findings that match nothing are false
 * positives if they land on a decoy or a human judged them so; otherwise they
 * wait for judgement, and precision is a range: unjudged counted as false
 * (strict) and left out (known). The strict figure is the one we hold to.
 */
import { sameBug, type Finding, type Lead, type ScanReport } from "@sandchest/engine/scan";
import type { Benchmark, CodeRange, ExpectedFinding } from "./benchmark";

/** Lines of slack either side of an expected location. */
export const TOLERANCE = 5;

/**
 * - `real`: an exploitable bug the benchmark doesn't list.
 * - `false_positive`: the attack doesn't work.
 * - `not_security`: true, but nobody but the attacker is harmed (reliability, self-harm, admin-only).
 * - `test_code`: in tests, fixtures or examples that don't ship.
 * - `duplicate`: the same bug as `duplicateOf`, a fingerprint or `expected:<id>`. A duplicate of an
 *   expected bug counts as finding it (the line ranges missed it); a duplicate of a finding absent
 *   from the scan takes that finding's verdict.
 */
export const VERDICTS = ["real", "false_positive", "not_security", "test_code", "duplicate"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface JudgementRecord {
  verdict: Verdict;
  /**
   * Where the judged finding pointed (class and cited lines, no code), so the
   * verdict also applies when a later run reports the same bug under another
   * fingerprint.
   */
  where?: { category: string; entry: string; path: string[] };
  /** Fingerprint of the canonical finding, for duplicates. */
  duplicateOf?: string;
  /** The severity a reviewer would give it, when it differs. */
  severity?: Finding["severity"];
  note?: string;
  by?: string;
  at?: string;
}
/** Human judgements by finding fingerprint. A bare string is shorthand for `{ verdict }` (older files). */
export type Judgements = Record<string, Verdict | JudgementRecord>;

export function judgementOf(judgements: Judgements, fingerprint: string): JudgementRecord | undefined {
  const value = judgements[fingerprint];
  return typeof value === "string" ? { verdict: value } : value;
}

const at = (spot: string) => {
  const split = spot.lastIndexOf(":");
  return { file: spot.slice(0, split), line: Number(spot.slice(split + 1)) };
};

/**
 * A finding's judgement: by fingerprint, or else by a judged finding that is
 * the same bug (same rule as rescans). A judged finding that is itself in the
 * scan (`present`) lends its verdict to nothing else: a second finding at its
 * lines is a different report (a missing rate limit on the login whose bypass
 * was judged), not the same bug under a new fingerprint.
 */
export function judgementFor(
  judgements: Judgements,
  finding: Pick<Finding, "fingerprint" | "category" | "entryPoint" | "attackPath">,
  present: ReadonlySet<string> = new Set(),
): JudgementRecord | undefined {
  const exact = judgementOf(judgements, finding.fingerprint);
  if (exact) return exact;
  for (const [print, value] of Object.entries(judgements)) {
    if (typeof value === "string" || !value.where || present.has(print)) continue;
    const judged = { fingerprint: print, category: value.where.category, entryPoint: at(value.where.entry), attackPath: value.where.path.map(at) };
    if (sameBug(judged, finding)) return value;
  }
  return undefined;
}

/** The location part of a judgement, from the finding being judged. */
export function whereOf(finding: Pick<Finding, "category" | "entryPoint" | "attackPath">): NonNullable<JudgementRecord["where"]> {
  return { category: finding.category, entry: `${finding.entryPoint.file}:${finding.entryPoint.line}`, path: finding.attackPath.map((s) => `${s.file}:${s.line}`) };
}

export type Outcome = "true_positive" | "false_positive" | "duplicate" | "unjudged";

export interface FindingScore {
  fingerprint: string;
  title: string;
  category: Finding["category"];
  severity: Finding["severity"];
  confidence: Finding["confidence"];
  at: string;
  /** Shown by default: critical or high, not low confidence. */
  shown: boolean;
  /** Every cited line is in test, fixture or example code. */
  testCode: boolean;
  /** Expected ids this finding matches. */
  matches: string[];
  outcome: Outcome;
  /** Why it was ruled a false positive or duplicate. */
  reason?: "decoy" | "judged" | "same_expected" | Exclude<Verdict, "real" | "duplicate">;
}

export interface BenchmarkScore {
  name: string;
  kind: Benchmark["kind"];
  expected: { total: number; serious: number };
  found: { total: number; serious: number; seriousShown: number };
  missed: Array<Pick<ExpectedFinding, "id" | "title" | "severity">>;
  /** Shown findings: high or critical, not low confidence. */
  shown: { total: number; truePositives: number; falsePositives: number; duplicates: number; unjudged: number; testCode: number };
  /** Every finding, whatever its severity. */
  all: { total: number; truePositives: number; falsePositives: number; duplicates: number; unjudged: number };
  /** Recall over critical and high expected findings. */
  recall: number | null;
  /** Recall counting only expected critical/high bugs that a shown finding matched: what a user sees by default. */
  recallShown: number | null;
  recallAll: number | null;
  precision: { lower: number | null; known: number | null };
  /** Over every finding, any severity. */
  precisionAll: { lower: number | null; known: number | null };
  /** Severity of the best match for each found expected bug, against the benchmark's. */
  severity: { exact: number; under: number; over: number };
  /** Expected id → the fingerprint that matched it first (for stability across runs). */
  matchedBy: Record<string, string>;
  /**
   * Findings the engine merged into another (`report.merged`), and those whose
   * merge hid a bug: the absorbed finding matched an expected bug no kept
   * finding reports, or a reviewer judged it a distinct real bug.
   */
  merges: { total: number; lost: Array<{ fingerprint: string; title: string; bug: string }> };
  findings: FindingScore[];
}

const SERIOUS = new Set(["critical", "high"]);
const RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/** Test, fixture, example and benchmark directories. Kept independent of the engine's own list so the harness measures it. */
const TEST_SEGMENT = /(^|\/)(tests?|__tests__|__mocks__|fixtures?|testdata|mocks?|specs?|examples?|e2e|stories|cypress|playwright|evals?|benchmarks?|demo|samples?)(\/|$)/i;

export function isTestPath(file: string): boolean {
  return TEST_SEGMENT.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || /(^|\/)test_[^/]+\.py$/.test(file);
}

export function isShown(finding: Pick<Finding, "severity" | "confidence">): boolean {
  return SERIOUS.has(finding.severity) && finding.confidence !== "low";
}

/** The verdict behind a chain of duplicates (a → b → c): what the canonical finding was judged. */
function canonical(judgements: Judgements, fingerprint: string): JudgementRecord | undefined {
  const seen = new Set<string>();
  let record = judgementOf(judgements, fingerprint);
  while (record?.verdict === "duplicate" && record.duplicateOf && !record.duplicateOf.startsWith("expected:") && !seen.has(record.duplicateOf)) {
    seen.add(record.duplicateOf);
    record = judgementOf(judgements, record.duplicateOf);
  }
  return record?.verdict === "duplicate" ? undefined : record;
}

export function score(benchmark: Benchmark, report: ScanReport, judgements: Judgements = {}): BenchmarkScore {
  const firstMatch = new Map<string, string>();
  const severityByExpected = new Map<string, Finding["severity"]>();
  const present = new Set(report.findings.map((f) => f.fingerprint));
  const known = new Set(benchmark.expected.map((e) => e.id));
  // Pass 1: which expected locations ("spots") each finding could be reporting.
  const prepared = report.findings.map((finding) => {
    const spots = new Set<string>();
    const matches: string[] = [];
    for (const expected of benchmark.expected) {
      const range = matchRange(expected, finding);
      if (range === null) continue;
      spots.add(`${expected.id}#${range}`);
      matches.push(expected.id);
    }
    let judged = judgementFor(judgements, finding, present);
    // A reviewer's "duplicate of expected:<id>" is a match the line ranges missed: it can report any of that bug's locations.
    const judgedExpected = judged?.verdict === "duplicate" && judged.duplicateOf?.startsWith("expected:") ? judged.duplicateOf.slice("expected:".length) : undefined;
    if (judgedExpected && known.has(judgedExpected)) {
      if (!matches.includes(judgedExpected)) {
        const ranges = benchmark.expected.find((e) => e.id === judgedExpected)!.locations.length;
        for (let i = 0; i < ranges; i++) spots.add(`${judgedExpected}#${i}`);
        matches.push(judgedExpected);
      }
      judged = undefined;
    }
    // A duplicate of another finding is only a duplicate when that finding is in this report; otherwise it stands in for it.
    if (judged?.verdict === "duplicate" && judged.duplicateOf && !judgedExpected && !present.has(judged.duplicateOf)) judged = canonical(judgements, judged.duplicateOf);
    return { finding, spots: [...spots], matches, judged };
  });
  // Pass 2: each spot is credited to one finding and each finding to one spot (a maximum matching, earlier
  // findings first). A finding whose lines also fall in a neighbouring bug's range no longer takes both, so the
  // finding that really reports the neighbour is not counted as its duplicate.
  const owner = new Map<string, number>();
  const assign = (i: number, seen: Set<string>): boolean => {
    for (const spot of prepared[i]!.spots) {
      if (seen.has(spot)) continue;
      seen.add(spot);
      const current = owner.get(spot);
      if (current === undefined || assign(current, seen)) {
        owner.set(spot, i);
        return true;
      }
    }
    return false;
  };
  prepared.forEach((_, i) => assign(i, new Set()));
  const credited = new Set(owner.values());

  const findings: FindingScore[] = prepared.map(({ finding, spots, matches, judged }, i) => {
    const sink = finding.attackPath.at(-1)!;
    const cited = [finding.entryPoint, ...finding.attackPath];
    const decoy = benchmark.decoys.some((range) => within(range, sink.file, sink.line, 0));
    let outcome: Outcome = "unjudged";
    let reason: FindingScore["reason"];
    if (spots.length > 0 && !credited.has(i)) {
      outcome = "duplicate";
      reason = "same_expected";
    } else if (spots.length > 0 || judged?.verdict === "real") outcome = "true_positive";
    else if (judged?.verdict === "duplicate") {
      outcome = "duplicate";
      reason = "judged";
    } else if (decoy || judged) {
      outcome = "false_positive";
      reason = decoy ? "decoy" : judged!.verdict === "false_positive" ? "judged" : (judged!.verdict as "not_security" | "test_code");
    }
    for (const id of matches) {
      if (!firstMatch.has(id)) firstMatch.set(id, finding.fingerprint);
      const best = severityByExpected.get(id);
      if (!best || RANK[finding.severity] < RANK[best]) severityByExpected.set(id, finding.severity);
    }
    return {
      fingerprint: finding.fingerprint,
      title: finding.title,
      category: finding.category,
      severity: finding.severity,
      confidence: finding.confidence,
      at: `${sink.file}:${sink.line}`,
      shown: isShown(finding),
      testCode: cited.every((step) => isTestPath(step.file)),
      matches,
      outcome,
      reason,
    };
  });

  const found = new Set(firstMatch.keys());
  const foundShown = new Set(findings.filter((f) => f.shown).flatMap((f) => f.matches));
  for (const expected of benchmark.expected) {
    if (expected.category === "hardcoded_secret" && report.leads.some((lead) => matchesSecretLead(expected, lead))) found.add(expected.id);
  }

  const serious = benchmark.expected.filter((e) => SERIOUS.has(e.severity));
  const shown = findings.filter((f) => f.shown);
  const tally = (list: FindingScore[]) => {
    const count = (outcome: Outcome) => list.filter((f) => f.outcome === outcome).length;
    return { total: list.length, truePositives: count("true_positive"), falsePositives: count("false_positive"), duplicates: count("duplicate"), unjudged: count("unjudged") };
  };
  const shownTally = tally(shown);
  const allTally = tally(findings);
  const severity = { exact: 0, under: 0, over: 0 };
  for (const expected of benchmark.expected) {
    const got = severityByExpected.get(expected.id);
    if (!got) continue;
    const delta = RANK[got] - RANK[expected.severity];
    if (delta === 0) severity.exact++;
    else if (delta > 0) severity.under++;
    else severity.over++;
  }

  return {
    name: benchmark.name,
    kind: benchmark.kind,
    expected: { total: benchmark.expected.length, serious: serious.length },
    found: { total: found.size, serious: serious.filter((e) => found.has(e.id)).length, seriousShown: serious.filter((e) => foundShown.has(e.id)).length },
    missed: benchmark.expected.filter((e) => !found.has(e.id)).map(({ id, title, severity }) => ({ id, title, severity })),
    shown: { ...shownTally, testCode: shown.filter((f) => f.testCode).length },
    all: allTally,
    recall: ratio(serious.filter((e) => found.has(e.id)).length, serious.length),
    recallShown: ratio(serious.filter((e) => foundShown.has(e.id)).length, serious.length),
    recallAll: ratio(found.size, benchmark.expected.length),
    precision: precisionOf(shownTally),
    precisionAll: precisionOf(allTally),
    severity,
    matchedBy: Object.fromEntries(firstMatch),
    merges: mergeLosses(benchmark, report, judgements, found),
    findings,
  };
}

function mergeLosses(benchmark: Benchmark, report: ScanReport, judgements: Judgements, found: Set<string>): BenchmarkScore["merges"] {
  const merged = report.merged ?? [];
  const lost: BenchmarkScore["merges"]["lost"] = [];
  for (const { into, finding } of merged) {
    const hidden = benchmark.expected.find((expected) => !found.has(expected.id) && matchRange(expected, finding) !== null);
    const judged = judgementFor(judgements, finding);
    // Judged a distinct real bug, unless what it merged into was judged its duplicate.
    const primary = report.findings.find((f) => f.fingerprint === into);
    const distinct = judged?.verdict === "real" && !(primary && judgementFor(judgements, primary)?.duplicateOf === finding.fingerprint);
    if (hidden || distinct) lost.push({ fingerprint: finding.fingerprint, title: finding.title, bug: hidden ? hidden.id : "judged real" });
  }
  return { total: merged.length, lost };
}

/** Over unique findings: duplicates are left out (they are counted as the duplicate rate). */
function precisionOf(t: { truePositives: number; falsePositives: number; unjudged: number }): { lower: number | null; known: number | null } {
  return { lower: ratio(t.truePositives, t.truePositives + t.falsePositives + t.unjudged), known: ratio(t.truePositives, t.truePositives + t.falsePositives) };
}

export function matchesFinding(expected: ExpectedFinding, finding: Pick<Finding, "category" | "cwe" | "entryPoint" | "attackPath">, ranges = expected.locations): boolean {
  return matchRange(expected, finding, ranges) !== null;
}

/**
 * Which expected location a finding lands on, or null. The class must agree
 * (category or CWE), and either its sink (last hop) is within a location, or
 * two of its cited lines are. One passing hop is not enough: attack paths run
 * through shared lines (route tables, auth middleware) that sit inside other
 * bugs' locations.
 */
export function matchRange(expected: ExpectedFinding, finding: Pick<Finding, "category" | "cwe" | "entryPoint" | "attackPath">, ranges = expected.locations): number | null {
  const sameClass = finding.category === expected.category || (finding.cwe !== null && expected.cwe.includes(finding.cwe));
  if (!sameClass) return null;
  const sink = finding.attackPath.at(-1)!;
  const atSink = ranges.findIndex((range) => within(range, sink.file, sink.line, TOLERANCE));
  if (atSink >= 0) return atSink;
  const cited = [...new Map([finding.entryPoint, ...finding.attackPath].map((s) => [`${s.file}:${s.line}`, s])).values()];
  const counts = ranges.map((range) => cited.filter((s) => within(range, s.file, s.line, TOLERANCE)).length);
  if (counts.reduce((a, b) => a + b, 0) < 2) return null;
  return counts.indexOf(Math.max(...counts));
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

export function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * A scan of the commit that fixed the benchmark's bugs. Any finding there that
 * still matches a fixed bug (at its patched location) is a confirmed false
 * positive: the fix is the ground truth. Partial fixes are left out.
 */
export interface PatchedScore {
  name: string;
  /** Expected bugs with a clean fix and known patched location. */
  checked: number;
  /** Of those, how many the scan still reported. */
  reflagged: string[];
  findings: number;
}

export function scorePatched(benchmark: Benchmark, report: ScanReport): PatchedScore {
  const fixed = benchmark.expected.filter((e) => !e.partialFix && e.patchedLocations && e.patchedLocations.length > 0);
  const reflagged = fixed.filter((e) => report.findings.some((f) => isShown(f) && matchesFinding(e, f, e.patchedLocations))).map((e) => e.id);
  return { name: benchmark.name, checked: fixed.length, reflagged, findings: report.findings.length };
}

export interface Aggregate {
  recall: number | null;
  recallShown: number | null;
  precision: { lower: number | null; known: number | null };
  precisionAll: { lower: number | null; known: number | null };
  unjudged: number;
  shown: number;
  /** Duplicates ÷ shown findings. */
  duplicateRate: number | null;
  /** Shown findings entirely in test/fixture/example code ÷ shown findings. */
  testCodeRate: number | null;
  severity: { exact: number; under: number; over: number; accuracy: number | null };
  /** Fixed bugs still reported on the fixed commit ÷ fixed bugs checked. */
  patchedFpRate: number | null;
  patchedChecked: number;
  /** Findings merged into another, and bugs those merges hid (should be 0). */
  merged: number;
  mergeLosses: number;
}

/** Pools counts across benchmarks rather than averaging ratios, so big benchmarks weigh more. */
export function aggregate(scores: BenchmarkScore[], patched: PatchedScore[] = []): Aggregate {
  const vulnerable = scores.filter((s) => s.kind === "vulnerable");
  const sum = (pick: (s: BenchmarkScore) => number, list = scores) => list.reduce((n, s) => n + pick(s), 0);
  const expected = sum((s) => s.expected.serious, vulnerable);
  const tp = sum((s) => s.shown.truePositives);
  const fp = sum((s) => s.shown.falsePositives);
  const unjudged = sum((s) => s.shown.unjudged);
  const shown = sum((s) => s.shown.total);
  const allTp = sum((s) => s.all.truePositives);
  const allFp = sum((s) => s.all.falsePositives);
  const allUnjudged = sum((s) => s.all.unjudged);
  const severity = { exact: sum((s) => s.severity.exact), under: sum((s) => s.severity.under), over: sum((s) => s.severity.over) };
  const checked = patched.reduce((n, p) => n + p.checked, 0);
  return {
    recall: ratio(sum((s) => s.found.serious, vulnerable), expected),
    recallShown: ratio(sum((s) => s.found.seriousShown, vulnerable), expected),
    precision: { lower: ratio(tp, tp + fp + unjudged), known: ratio(tp, tp + fp) },
    precisionAll: { lower: ratio(allTp, allTp + allFp + allUnjudged), known: ratio(allTp, allTp + allFp) },
    unjudged,
    shown,
    duplicateRate: ratio(sum((s) => s.shown.duplicates), shown),
    testCodeRate: ratio(sum((s) => s.shown.testCode), shown),
    severity: { ...severity, accuracy: ratio(severity.exact, severity.exact + severity.under + severity.over) },
    patchedFpRate: ratio(patched.reduce((n, p) => n + p.reflagged.length, 0), checked),
    patchedChecked: checked,
    merged: sum((s) => s.merges.total),
    mergeLosses: sum((s) => s.merges.lost.length),
  };
}

/**
 * Agreement between repeated scans of one benchmark. Variance is structural
 * (parallel agentic exploration), so each change is judged on several runs.
 */
export interface Stability {
  name: string;
  runs: number;
  /** Serious recall per run. */
  recalls: number[];
  /** Serious expected bugs found in any run ÷ serious expected. */
  unionRecall: number | null;
  /** Serious expected bugs found in every run ÷ found in any. */
  agreement: number | null;
  /**
   * Of expected bugs found in two runs, the share reported under the same
   * fingerprint. Below 1, a rescan files the same bug again as a new finding.
   */
  fingerprintStability: number | null;
  /** The same, after the product recognises stored findings on a rescan (`adoptKnownFingerprints`): what users see. */
  recognised?: number | null;
}

export function stability(benchmark: Benchmark, runs: BenchmarkScore[]): Stability {
  const serious = benchmark.expected.filter((e) => SERIOUS.has(e.severity)).map((e) => e.id);
  const foundIn = (s: BenchmarkScore) => new Set(serious.filter((id) => !s.missed.some((m) => m.id === id)));
  const sets = runs.map(foundIn);
  const union = new Set(sets.flatMap((s) => [...s]));
  const every = [...union].filter((id) => sets.every((s) => s.has(id)));
  let pairs = 0;
  let same = 0;
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      for (const id of Object.keys(runs[i]!.matchedBy)) {
        const other = runs[j]!.matchedBy[id];
        if (!other) continue;
        pairs++;
        // Same bug, same identity: either finding's fingerprint appears among the other run's matches for it.
        const left = new Set(runs[i]!.findings.filter((f) => f.matches.includes(id)).map((f) => f.fingerprint));
        if (runs[j]!.findings.some((f) => f.matches.includes(id) && left.has(f.fingerprint))) same++;
      }
    }
  }
  return {
    name: benchmark.name,
    runs: runs.length,
    recalls: runs.map((s) => s.recall ?? 0),
    unionRecall: ratio(union.size, serious.length),
    agreement: ratio(every.length, union.size),
    fingerprintStability: ratio(same, pairs),
  };
}
