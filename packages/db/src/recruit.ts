/** What setting up an org reads: the accounts a person may set up, an account's repositories, and Sandchest's running total. */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "./client";
import { findings, orgAdmins, orgBilling, orgs, repos, scans } from "./schema";


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

/**
 * The newest findings Sandchest has made, across all orgs, for the landing
 * page's live feed: only how bad each is, what kind of hole and when, never
 * the title, the code, the repository or whose it is. Dismissed findings and
 * ones the trust gate couldn't back are left out. Nothing younger than
 * `minAgeMs` is returned, so a finding can't be tied to a push someone just
 * watched land, and a day's findings are only returned once they came from
 * at least `minOrgs` different orgs, so none can be pinned on one. The org
 * is only counted here; it never leaves the database.
 */
export async function recentFindingClasses(
  database: Db,
  { limit, minAgeMs, maxAgeDays, minOrgs }: { limit: number; minAgeMs: number; maxAgeDays: number; minOrgs: number },
): Promise<Array<{ severity: string; category: string; firstSeenAt: Date }>> {
  const rows = await database.execute<{ severity: string; category: string; first_seen_at: Date | string }>(sql`
    with shown as (
      select f.severity, f.category, f.first_seen_at, r.org_id, (f.first_seen_at at time zone 'UTC')::date as day
      from ${findings} f
      join ${repos} r on r.id = f.repo_id
      where f.status <> 'dismissed'
        and (f.trust is null or f.trust <> 'unconfirmed')
        and f.first_seen_at <= now() - make_interval(secs => ${minAgeMs / 1000})
        and f.first_seen_at > now() - make_interval(days => ${maxAgeDays})
    ),
    crowded as (
      select day from shown group by day having count(distinct org_id) >= ${minOrgs}
    )
    select severity, category, first_seen_at from shown
    where day in (select day from crowded)
    order by first_seen_at desc
    limit ${limit}
  `);
  return rows.map((row) => ({ severity: row.severity, category: row.category, firstSeenAt: new Date(row.first_seen_at) }));
}
