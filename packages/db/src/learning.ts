/**
 * What Sandchest learns from use. Two views over the team verdicts we already
 * store, neither of which reads code or finding text beyond what a replay needs:
 *
 * - `outcomeStats`: counts by signal, category and trust tier of how findings
 *   ended (fixed, dismissed and why, still open). Enum values and counts only,
 *   so it is safe to aggregate across every customer. It tells us which signals
 *   produce real bugs and which produce noise, so tuning follows evidence.
 * - `fixedPairs`: every finding a fix check saw fixed is real ground truth — the
 *   commit it was found at is the vulnerable version, the commit it was fixed at
 *   is the patched one. Replaying the finding against both (evals `fpcheck`)
 *   measures recall and false positives on real bugs, and the set grows with use.
 *   It names repositories and commits, so it is for operator evals only, and by
 *   default public repositories only.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { findingEvents, findings, repoMemory, repos, scans } from "./schema";

export interface OutcomeRow {
  /** The signal that raised the finding (`hunter`, `missing_check`, `vulnerable_dependency`, …). */
  source: string;
  category: string;
  trust: string;
  /** `open`, `fixed`, `false_positive`, `accepted_risk` or `wont_fix`. */
  outcome: string;
  count: number;
}

export async function outcomeStats(database: Db): Promise<OutcomeRow[]> {
  const rows = await database.$client<Array<{ source: string; category: string; trust: string | null; outcome: string; count: number }>>`
    select src as source, f.category, f.trust,
           case when f.status = 'dismissed' then f.dismiss_reason::text else f.status::text end as outcome,
           count(*)::int as count
    from findings f
    cross join lateral unnest(case when cardinality(f.sources) = 0 then array['unknown'] else f.sources end) as src
    group by 1, 2, 3, 4
    order by 1, 2, 3, 4`;
  return rows.map((row) => ({ ...row, trust: row.trust ?? "unrated" }));
}

export interface FixedPair {
  findingId: string;
  repo: string;
  /** Commit the finding was found at: the vulnerable version. */
  vulnerableSha: string;
  /** Commit at which a fix check saw it gone: the patched version. */
  patchedSha: string;
  /** The finding as a candidate, minus code excerpts (dropped when it was resolved). */
  candidate: {
    title: string;
    category: string;
    severity: string;
    entryPoint: { file: string; line: number; description: string };
    path: Array<{ file: string; line: number; note: string }>;
    preconditions: { attacker: string; details: string };
    proofOfConcept: string;
    impact: string;
  };
  /** The repository's stored threat model, if any. */
  threatModel: unknown;
}

/**
 * Findings a fix check saw fixed, as vulnerable/patched pairs. Findings a person
 * marked fixed by hand have no commit to replay against and are left out.
 */
export async function fixedPairs(database: Db, options: { includePrivate?: boolean } = {}): Promise<FixedPair[]> {
  const rows = await database
    .select({
      id: findings.id,
      repo: repos.fullName,
      private: repos.private,
      title: findings.title,
      category: findings.category,
      severity: findings.severity,
      entryPoint: findings.entryPoint,
      attackPath: findings.attackPath,
      attacker: findings.attacker,
      preconditions: findings.preconditions,
      proofOfConcept: findings.proofOfConcept,
      impact: findings.impact,
      foundAt: sql<string>`(select s.head_sha from ${scans} s where s.id = ${findings.sourceScanId})`,
      fixedAt: sql<string | null>`(select s.head_sha from ${findingEvents} e join ${scans} s on s.id = e.scan_id where e.finding_id = ${findings.id} and e.type = 'fixed' order by e.created_at desc limit 1)`,
      threatModel: repoMemory.threatModel,
    })
    .from(findings)
    .innerJoin(repos, eq(repos.id, findings.repoId))
    .leftJoin(repoMemory, eq(repoMemory.repoId, findings.repoId))
    .where(and(eq(findings.status, "fixed")));
  return rows
    .filter((row) => (options.includePrivate || !row.private) && row.foundAt && row.fixedAt && row.foundAt !== row.fixedAt)
    .map((row) => ({
      findingId: row.id,
      repo: row.repo,
      vulnerableSha: row.foundAt,
      patchedSha: row.fixedAt!,
      candidate: {
        title: row.title,
        category: row.category,
        severity: row.severity,
        entryPoint: row.entryPoint as FixedPair["candidate"]["entryPoint"],
        path: (row.attackPath as Array<{ file: string; line: number; note: string }>).map(({ file, line, note }) => ({ file, line, note })),
        preconditions: { attacker: row.attacker, details: row.preconditions },
        proofOfConcept: row.proofOfConcept,
        impact: row.impact,
      },
      threatModel: row.threatModel ?? null,
    }));
}
