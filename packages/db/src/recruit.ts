/** What setting up an org reads: the accounts a person may set up, an account's repositories, and Sandchest's running total. */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "./client";
import { orgAdmins, orgBilling, orgs, repos, scans } from "./schema";


/** The orgs a user may set up: installed accounts they administer, with their plan. */
export async function adminOrgs(database: Db, userId: string) {
  return database
    .select({ id: orgs.id, login: orgs.githubLogin, type: orgs.type, githubAccountId: orgs.githubAccountId, installationId: orgs.installationId, settings: orgs.settings, planId: orgBilling.planId, activatedAt: orgBilling.activatedAt })
    .from(orgAdmins)
    .innerJoin(orgs, eq(orgs.id, orgAdmins.orgId))
    .leftJoin(orgBilling, eq(orgBilling.orgId, orgs.id))
    .where(and(eq(orgAdmins.userId, userId), isNotNull(orgs.installationId)))
    .orderBy(orgs.githubLogin);
}

/** An org's installed repositories, largest first (unsized ones last). */
export async function orgRepos(database: Db, orgId: string) {
  return database
    .select({ id: repos.id, githubRepoId: repos.githubRepoId, fullName: repos.fullName, private: repos.private, loc: repos.loc })
    .from(repos)
    .where(and(eq(repos.orgId, orgId), eq(repos.enabled, true)))
    .orderBy(sql`${repos.loc} desc nulls last`, repos.fullName);
}

/**
 * Every line Sandchest has read, across all orgs: the size of the repository
 * at each completed scan, reviews included (a review indexes the whole repo
 * to follow calls past the diff). A review without a recorded size counts its
 * changed lines. A total only; nothing about any one org.
 */
export async function linesScanned(database: Db): Promise<{ lines: number; running: number }> {
  const [row] = await database.execute<{ lines: string | null; running: string }>(sql`
    select
      (select sum(coalesce((stats ->> 'loc')::bigint, (stats -> 'review' ->> 'changedLines')::bigint))
        from ${scans} where status = 'completed' and stats is not null) as lines,
      (select count(*) from ${scans} where status in ('running', 'publishing')) as running
  `);
  return { lines: Number(row?.lines ?? 0), running: Number(row?.running ?? 0) };
}
