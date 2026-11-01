/**
 * Ensemble: run the hunt more than once and use cross-run agreement as a
 * reliability signal, instead of fighting the run-to-run variance that is
 * structural to agentic exploration (measured: two identical scans share only
 * ~17% of findings even at temperature 0 with a seed).
 *
 * Two things fall out of K runs:
 *   - **union** — the recall-stable set. A real bug a single run misses is
 *     usually caught by another, so the union recovers the ones that flicker.
 *   - **support** — how many of the K runs found each finding. A finding seen
 *     in every run is reliable; one seen once is exploratory. Support is an
 *     evidence signal orthogonal to the skeptic's confidence and the code-path
 *     proof, and it is *earned by the variance*, not defeated by it.
 *
 * Merging is deterministic and keyed on the stable fingerprint, so it is pure
 * and unit-testable; the cost is the K× hunt (recon is reused across runs).
 */
import { runScan, type ScanOptions, type ScanReport } from "./pipeline";
import { severityRank, type Finding } from "./schema";
import { trustRank } from "./trust";

export interface SupportedFinding extends Finding {
  /** How many of the ensemble's runs reported this finding. */
  support: { found: number; of: number };
}

export interface EnsembleReport {
  runs: number;
  /** Unioned findings, most severe → most supported → best-corroborated first. */
  findings: SupportedFinding[];
  /** Findings every run agreed on — the reliable core. */
  unanimous: number;
  /** Findings only one run saw — the exploratory tail. */
  singletons: number;
  perRun: Array<{ findings: number }>;
}

/** The instance to keep when the same fingerprint appears in several runs: strongest evidence wins. */
function stronger(a: Finding, b: Finding): Finding {
  const byTrust = trustRank(a.trust) - trustRank(b.trust);
  if (byTrust !== 0) return byTrust < 0 ? a : b;
  const bySeverity = severityRank(a.severity) - severityRank(b.severity);
  if (bySeverity !== 0) return bySeverity < 0 ? a : b;
  // Prefer the one that carries a validation record, then the longer attack path.
  if (!!a.validation !== !!b.validation) return a.validation ? a : b;
  return b.attackPath.length > a.attackPath.length ? b : a;
}

/** Unions findings across runs by fingerprint and annotates each with its support. */
export function mergeReports(reports: Array<{ findings: Finding[] }>): EnsembleReport {
  const runs = reports.length;
  const byPrint = new Map<string, { best: Finding; found: number }>();
  for (const report of reports) {
    // Count each fingerprint at most once per run, even if a run reported it twice.
    const seen = new Set<string>();
    for (const finding of report.findings) {
      if (seen.has(finding.fingerprint)) continue;
      seen.add(finding.fingerprint);
      const entry = byPrint.get(finding.fingerprint);
      if (!entry) byPrint.set(finding.fingerprint, { best: finding, found: 1 });
      else {
        entry.best = stronger(entry.best, finding);
        entry.found += 1;
      }
    }
  }

  const findings: SupportedFinding[] = [...byPrint.values()]
    .map(({ best, found }) => ({ ...best, support: { found, of: runs } }))
    .sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        b.support.found - a.support.found ||
        trustRank(a.trust) - trustRank(b.trust),
    );

  return {
    runs,
    findings,
    unanimous: findings.filter((f) => f.support.found === runs).length,
    singletons: findings.filter((f) => f.support.found === 1).length,
    perRun: reports.map((r) => ({ findings: r.findings.length })),
  };
}

/**
 * Runs a scan `runs` times and merges them. Recon runs once — its threat model
 * is reused for the rest — so only the hunt (the variable part) repeats; the
 * cost is roughly the hunt × runs, not the whole scan × runs.
 */
export async function runScanEnsemble(options: ScanOptions, runs: number): Promise<{ ensemble: EnsembleReport; reports: ScanReport[] }> {
  if (runs < 1) throw new Error("runs must be at least 1");
  const first = await runScan(options);
  const reports: ScanReport[] = [first];
  for (let i = 1; i < runs; i++) {
    if (options.signal?.aborted) break;
    reports.push(await runScan({ ...options, threatModel: first.threatModel }));
  }
  return { ensemble: mergeReports(reports), reports };
}
