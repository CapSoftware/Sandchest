/**
 * Per-repository review settings (PR review mode, deep scan schedule), the
 * scheduler's queries, and the state the pull requests panel and the PR
 * summary comment need.
 */
import { and, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "./client";
import { orgs, permissionCache, prComments, repos, scans, type DeepScanSchedule, type PrReviewMode } from "./schema";
import type { Org, Repo } from "./queries";

export interface RepoSettingsPatch {
  prReviews?: PrReviewMode;
  deepScanSchedule?: DeepScanSchedule;
  /** When the next scheduled deep scan is due; null with the schedule off. */
  nextDeepScanAt?: Date | null;
}

/**
 * Changes a repo's review settings if the user can push to it (the same
 * people who can start a deep scan of it). False otherwise.
 */
export async function updateRepoSettings(database: Db, userId: string, repoId: string, patch: RepoSettingsPatch): Promise<boolean> {
  if (Object.keys(patch).length === 0) return true;
  const rows = await database
    .update(repos)
    .set(patch)
    .where(and(eq(repos.id, repoId), eq(repos.enabled, true), sql`exists (select 1 from ${permissionCache} pc where pc.user_id = ${userId} and pc.repo_id = ${repos.id})`))
    .returning({ id: repos.id });
  return rows.length === 1;
}

/** Installed repos whose scheduled deep scan is due, oldest first. */
export async function dueScheduledRepos(database: Db, now = new Date(), limit = 25): Promise<Array<Repo & { org: Org }>> {
  const rows = await database
    .select({ repo: repos, org: orgs })
    .from(repos)
    .innerJoin(orgs, eq(orgs.id, repos.orgId))
    .where(and(isNotNull(repos.nextDeepScanAt), lte(repos.nextDeepScanAt, now), eq(repos.enabled, true), isNotNull(orgs.installationId)))
    .orderBy(repos.nextDeepScanAt)
    .limit(limit);
  return rows.map(({ repo, org }) => ({ ...repo, org }));
}

/**
 * Moves a repo's due run on to `next`, if it is still the run the caller saw:
 * two sweeps racing for the same run agree on one winner.
 */
export async function claimScheduledRun(database: Db, repoId: string, due: Date, next: Date): Promise<boolean> {
  const rows = await database
    .update(repos)
    .set({ nextDeepScanAt: next })
    .where(and(eq(repos.id, repoId), eq(repos.nextDeepScanAt, due), sql`${repos.deepScanSchedule} <> 'off'`))
    .returning({ id: repos.id });
  return rows.length === 1;
}

/** The commit the repo's last finished deep scan read, so a schedule can skip code that hasn't changed. */
export async function lastDeepScanHead(database: Db, repoId: string): Promise<string | undefined> {
  const [row] = await database
    .select({ headSha: scans.headSha })
    .from(scans)
    .where(and(eq(scans.repoId, repoId), eq(scans.kind, "deep"), eq(scans.status, "completed")))
    .orderBy(desc(scans.createdAt))
    .limit(1);
  return row?.headSha;
}

export interface PrReviewState {
  scanId: string;
  status: string;
  headSha: string;
  credits: number;
  trigger: string;
  /** Findings the review reported (dismissed ones included). */
  findings: number;
  at: Date;
}

/** The latest review of each of these pull requests, by PR number. One query. */
export async function prReviewStates(database: Db, repoId: string, prNumbers: number[]): Promise<Map<number, PrReviewState>> {
  if (prNumbers.length === 0) return new Map();
  const rows = await database
    .selectDistinctOn([scans.prNumber], {
      prNumber: scans.prNumber,
      scanId: scans.id,
      status: scans.status,
      headSha: scans.headSha,
      credits: scans.credits,
      trigger: scans.trigger,
      findings: sql<number>`coalesce(jsonb_array_length(${scans.stats} -> 'findingIds'), 0)::int`,
      at: sql<string>`coalesce(${scans.finishedAt}, ${scans.startedAt}, ${scans.createdAt})`,
    })
    .from(scans)
    .where(and(eq(scans.repoId, repoId), eq(scans.kind, "pr_review"), inArray(scans.prNumber, prNumbers)))
    .orderBy(scans.prNumber, desc(scans.createdAt));
  return new Map(rows.map((row) => [row.prNumber!, { scanId: row.scanId, status: row.status, headSha: row.headSha, credits: row.credits, trigger: row.trigger, findings: row.findings, at: new Date(row.at) }]));
}

/** Sandchest's summary comment on a pull request, if it has posted one, and when the review it describes was created. */
export async function prComment(database: Db, repoId: string, prNumber: number): Promise<{ commentId: number; describes: Date | null } | undefined> {
  const [row] = await database
    .select({ commentId: prComments.commentId, describes: scans.createdAt })
    .from(prComments)
    .leftJoin(scans, eq(scans.id, prComments.scanId))
    .where(and(eq(prComments.repoId, repoId), eq(prComments.prNumber, prNumber)));
  return row ? { commentId: row.commentId, describes: row.describes } : undefined;
}

/**
 * Findings an earlier finished review of this pull request already reported:
 * those were posted inline then, so a later push doesn't post them again.
 */
export async function earlierPrFindings(database: Db, scan: { id: string; repoId: string; prNumber: number; createdAt: Date }): Promise<Set<string>> {
  const rows = await database.execute<{ id: string }>(sql`
    select distinct jsonb_array_elements_text(${scans.stats} -> 'findingIds') as id from ${scans}
    where ${scans.repoId} = ${scan.repoId} and ${scans.kind} = 'pr_review' and ${scans.prNumber} = ${scan.prNumber}
      and ${scans.status} = 'completed' and ${scans.id} <> ${scan.id} and ${scans.createdAt} < ${scan.createdAt.toISOString()}
      and jsonb_typeof(${scans.stats} -> 'findingIds') = 'array'
  `);
  return new Set(rows.map((row) => row.id));
}

export async function savePrComment(database: Db, input: { repoId: string; prNumber: number; commentId: number; scanId: string }): Promise<void> {
  await database
    .insert(prComments)
    .values(input)
    .onConflictDoUpdate({ target: [prComments.repoId, prComments.prNumber], set: { commentId: input.commentId, scanId: input.scanId, updatedAt: new Date() } });
}
