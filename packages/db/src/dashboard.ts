/**
 * What the dashboard reads and writes. Every read is scoped to a user through
 * `permission_cache`, which the web app refreshes from GitHub before it is
 * trusted (SPEC §3): a row there means GitHub reported push access or higher,
 * or an admin invited the person to the repo's org (see team.ts).
 */
import { and, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { Db } from "./client";
import { accounts, sessions, findingEvents, findings, orgAdmins, orgBilling, orgs, permissionCache, repos, scanEvents, scanMetrics, scans, users, type DeepScanSchedule, type OrgSettings, type PrReviewMode } from "./schema";
import { grantMemberships, lockUser } from "./team";

type Severity = "critical" | "high" | "medium" | "low";
export type RepoPermission = (typeof permissionCache.$inferSelect)["permission"];
export type User = typeof users.$inferSelect;

// ---- Access ----------------------------------------------------------------

export async function userById(database: Db, userId: string): Promise<User | undefined> {
  return database.query.users.findFirst({ where: eq(users.id, userId) });
}

/** Known, installed orgs by GitHub installation id. */
export async function orgsByInstallation(database: Db, installationIds: number[]) {
  if (installationIds.length === 0) return [];
  return database
    .select({ id: orgs.id, installationId: orgs.installationId, githubAccountId: orgs.githubAccountId, githubLogin: orgs.githubLogin, type: orgs.type })
    .from(orgs)
    .where(inArray(orgs.installationId, installationIds));
}

export async function repoIdsByGithubId(database: Db, githubRepoIds: number[]): Promise<Map<number, string>> {
  if (githubRepoIds.length === 0) return new Map();
  const rows = await database.select({ id: repos.id, githubRepoId: repos.githubRepoId }).from(repos).where(inArray(repos.githubRepoId, githubRepoIds));
  return new Map(rows.map((row) => [row.githubRepoId, row.id]));
}

/**
 * Records which GitHub account a user is, as GitHub itself reported it (the
 * OAuth account id, or `/user` read with their token). better-auth won't store
 * profile fields that users may not set themselves, so this does. Another row
 * still claiming the id is stale and loses it: the id is unique, and only the
 * token's owner can be that account.
 */
export async function setGithubIdentity(database: Db, userId: string, github: { id: number; login?: string }): Promise<void> {
  await database.transaction((tx) => linkGithub(tx, userId, github));
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function linkGithub(tx: Tx, userId: string, github: { id: number; login?: string }, extra: { accessCheckedAt?: Date } = {}): Promise<void> {
  await tx.update(users).set({ githubUserId: null }).where(and(eq(users.githubUserId, github.id), ne(users.id, userId)));
  await tx
    .update(users)
    .set({ githubUserId: github.id, ...(github.login ? { login: github.login } : {}), ...extra })
    .where(eq(users.id, userId));
}

/**
 * Replaces everything a user may see with what GitHub just reported, including who they are on GitHub,
 * then adds back what the orgs they joined by invite give (under the same lock as joining and leaving).
 */
export async function replaceAccess(
  database: Db,
  userId: string,
  access: { repos: Array<{ repoId: string; permission: RepoPermission }>; adminOrgIds: string[]; github: { id: number; login: string } },
  at = new Date(),
): Promise<void> {
  await database.transaction(async (tx) => {
    await lockUser(tx, userId);
    await tx.delete(permissionCache).where(eq(permissionCache.userId, userId));
    await tx.delete(orgAdmins).where(eq(orgAdmins.userId, userId));
    if (access.repos.length > 0) await tx.insert(permissionCache).values(access.repos.map((repo) => ({ userId, ...repo, via: "github" as const, checkedAt: at })));
    if (access.adminOrgIds.length > 0) await tx.insert(orgAdmins).values(access.adminOrgIds.map((orgId) => ({ userId, orgId, via: "github" as const, checkedAt: at })));
    await grantMemberships(tx, userId, at);
    await linkGithub(tx, userId, access.github, { accessCheckedAt: at });
  });
}

/** The signed-in person for a session token, in one query. Expired sessions return nothing. */
export async function sessionUser(database: Db, token: string): Promise<{ id: string; name: string; login: string | null; githubUserId: number | null; image: string | null; accessCheckedAt: Date | null; sessionExpiresAt: Date } | undefined> {
  const [row] = await database
    .select({ id: users.id, name: users.name, login: users.login, githubUserId: users.githubUserId, image: users.image, accessCheckedAt: users.accessCheckedAt, sessionExpiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.token, token), sql`${sessions.expiresAt} > now()`));
  return row;
}

/** The id of the user's GitHub account row, which better-auth needs to hand out its token. */
export async function githubAccountRowId(database: Db, userId: string): Promise<string | undefined> {
  const [row] = await database.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, userId), eq(accounts.providerId, "github"))).limit(1);
  return row?.id;
}

const canSee = (userId: string) => sql`exists (select 1 from ${permissionCache} pc where pc.user_id = ${userId} and pc.repo_id = ${repos.id})`;

// ---- Repos screen ----------------------------------------------------------

export interface DashboardRepo {
  id: string;
  fullName: string;
  private: boolean;
  orgId: string;
  orgLogin: string;
  /** Whether the user may change the org's settings and billing. */
  orgAdmin: boolean;
  /** The org's billing as last read from Autumn; null if never read. */
  billing: { planId: string | null; credits: number; checkedAt: Date } | null;
  loc: number | null;
  lastDeepScanAt: Date | null;
  open: Record<Severity, number>;
  lastScan: { id: string; kind: string; status: string; at: Date } | null;
  /** Pull request reviews in the last 30 days. */
  reviews30d: number;
  activeDeepScanId: string | null;
  /** Whether that deep scan is queued behind the repo's recon, to start from its map (see `pendingRecon`). */
  activeDeepScanWaitsForRecon: boolean;
  defaultBranch: string;
  /** When pull requests are reviewed: on every push, on request only, or never. */
  prReviews: PrReviewMode;
  deepScanSchedule: DeepScanSchedule;
  nextDeepScanAt: Date | null;
}

/**
 * Enabled repos the user can see, with open findings by severity, their latest
 * scan and recent reviews, most exposed first. One query. `repoId` narrows it to one.
 */
export async function dashboardRepos(database: Db, userId: string, options: { repoId?: string } = {}): Promise<DashboardRepo[]> {
  const rows = await database.execute<{
    id: string;
    full_name: string;
    private: boolean;
    org_id: string;
    org_login: string;
    org_admin: boolean;
    billing_checked_at: string | null;
    plan_id: string | null;
    credits: number | null;
    loc: number | null;
    last_deep_scan_at: string | null;
    critical: number;
    high: number;
    medium: number;
    low: number;
    scan_id: string | null;
    scan_kind: string | null;
    scan_status: string | null;
    scan_at: string | null;
    active_deep_id: string | null;
    deep_waits: boolean;
    reviews_30d: number;
    default_branch: string;
    pr_reviews: PrReviewMode;
    deep_scan_schedule: DeepScanSchedule;
    next_deep_scan_at: string | null;
  }>(sql`
    select r.id, r.full_name, r.private, o.id as org_id, o.github_login as org_login,
      r.default_branch, r.pr_reviews, r.deep_scan_schedule, r.next_deep_scan_at,
      exists (select 1 from ${orgAdmins} oa where oa.user_id = ${userId} and oa.org_id = o.id) as org_admin,
      ob.checked_at as billing_checked_at, ob.plan_id, ob.credits, r.loc, r.last_deep_scan_at,
      coalesce(f.critical, 0)::int as critical, coalesce(f.high, 0)::int as high,
      coalesce(f.medium, 0)::int as medium, coalesce(f.low, 0)::int as low,
      s.id as scan_id, s.kind as scan_kind, s.status as scan_status, coalesce(s.finished_at, s.started_at, s.created_at) as scan_at,
      d.id as active_deep_id,
      (d.status = 'queued' and exists (
        select 1 from ${scans} rc where rc.repo_id = r.id and rc.kind = 'recon' and rc.status in ('queued', 'running')
          and rc.created_at > now() - interval '30 minutes'
      )) is true as deep_waits,
      (select count(*) from ${scans} pr where pr.repo_id = r.id and pr.kind = 'pr_review' and pr.created_at > now() - interval '30 days')::int as reviews_30d
    from ${repos} r
    join ${orgs} o on o.id = r.org_id
    join ${permissionCache} pc on pc.repo_id = r.id and pc.user_id = ${userId}
    left join ${orgBilling} ob on ob.org_id = o.id
    left join lateral (
      select count(*) filter (where severity = 'critical') as critical,
             count(*) filter (where severity = 'high') as high,
             count(*) filter (where severity = 'medium') as medium,
             count(*) filter (where severity = 'low') as low
      from ${findings} where repo_id = r.id and status = 'open' and confidence <> 'low'
    ) f on true
    left join lateral (
      select id, kind, status, finished_at, started_at, created_at from ${scans}
      where repo_id = r.id order by created_at desc limit 1
    ) s on true
    left join lateral (
      select id, status from ${scans} where repo_id = r.id and kind = 'deep' and status in ('queued', 'running', 'publishing') limit 1
    ) d on true
    where r.enabled ${options.repoId ? sql`and r.id = ${options.repoId}` : sql``}
    order by coalesce(f.critical, 0) desc, coalesce(f.high, 0) desc, coalesce(f.medium, 0) desc, r.full_name
  `);
  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    private: row.private,
    orgId: row.org_id,
    orgLogin: row.org_login,
    orgAdmin: row.org_admin,
    billing: row.billing_checked_at ? { planId: row.plan_id, credits: row.credits ?? 0, checkedAt: new Date(row.billing_checked_at) } : null,
    loc: row.loc,
    lastDeepScanAt: row.last_deep_scan_at ? new Date(row.last_deep_scan_at) : null,
    open: { critical: row.critical, high: row.high, medium: row.medium, low: row.low },
    lastScan: row.scan_id ? { id: row.scan_id, kind: row.scan_kind!, status: row.scan_status!, at: new Date(row.scan_at!) } : null,
    reviews30d: row.reviews_30d,
    activeDeepScanId: row.active_deep_id,
    activeDeepScanWaitsForRecon: row.deep_waits,
    defaultBranch: row.default_branch,
    prReviews: row.pr_reviews,
    deepScanSchedule: row.deep_scan_schedule,
    nextDeepScanAt: row.next_deep_scan_at ? new Date(row.next_deep_scan_at) : null,
  }));
}

/** Names of the enabled repos the user can see, for filters. */
export async function visibleRepos(database: Db, userId: string): Promise<Array<{ id: string; fullName: string }>> {
  return database.select({ id: repos.id, fullName: repos.fullName }).from(repos).where(and(eq(repos.enabled, true), canSee(userId))).orderBy(repos.fullName);
}

/** One repo, if the user can see it and it is still installed. */
export async function repoForUser(database: Db, userId: string, repoId: string) {
  const [row] = await database
    .select({ repo: repos, org: orgs })
    .from(repos)
    .innerJoin(orgs, eq(orgs.id, repos.orgId))
    .where(and(eq(repos.id, repoId), canSee(userId)));
  return row;
}

// ---- Findings screen -------------------------------------------------------

export interface FindingFilters {
  repoId?: string;
  severities?: Severity[];
  status?: "open" | "fixed" | "dismissed";
  /** Low-confidence findings are hidden unless asked for. */
  includeLowConfidence?: boolean;
}

export interface FindingListItem {
  id: string;
  title: string;
  severity: Severity;
  confidence: "high" | "medium" | "low";
  status: string;
  category: string;
  repoId: string;
  repoFullName: string;
  sink: { file: string; line: number } | null;
  /** How many other places the finding affects, beside the one at `sink`. */
  morePlaces: number;
  sourceKind: string;
  prNumber: number | null;
  lastSeenAt: Date;
  stale: boolean;
}

/**
 * How many other places a finding affects, as `findingPlaces` counts them: the folded reports marked as
 * variants. 0 when the column is null, as it is on findings stored before it existed.
 */
const MORE_PLACES = sql<number>`case when jsonb_typeof(${findings.alsoReported}) = 'array' then (select count(*)::int from jsonb_array_elements(${findings.alsoReported}) report where report -> 'variant' = 'true'::jsonb) else 0 end`;

const SEVERITY_ORDER = sql`case ${findings.severity} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`;

/** The findings list's filters as conditions; the status only when one is given. */
function findingConditions(userId: string, filters: FindingFilters): SQL[] {
  const where: SQL[] = [canSee(userId), eq(repos.enabled, true)];
  if (filters.status) where.push(eq(findings.status, filters.status));
  if (filters.repoId) where.push(eq(findings.repoId, filters.repoId));
  if (filters.severities?.length) where.push(inArray(findings.severity, filters.severities));
  if (!filters.includeLowConfidence) where.push(sql`${findings.confidence} <> 'low'`);
  return where;
}

/** The most findings the list shows, and the most an export copies. */
export const FINDING_LIST_LIMIT = 300;

export async function dashboardFindings(database: Db, userId: string, filters: FindingFilters = {}, limit = FINDING_LIST_LIMIT): Promise<FindingListItem[]> {
  const where = findingConditions(userId, { ...filters, status: filters.status ?? "open" });
  const rows = await database
    .select({
      id: findings.id,
      title: findings.title,
      severity: findings.severity,
      confidence: findings.confidence,
      status: findings.status,
      category: findings.category,
      repoId: findings.repoId,
      repoFullName: repos.fullName,
      sink: sql<{ file: string; line: number } | null>`${findings.attackPath} -> -1`,
      morePlaces: MORE_PLACES,
      sourceKind: findings.sourceKind,
      prNumber: findings.prNumber,
      lastSeenAt: findings.lastSeenAt,
      staleAt: findings.staleAt,
    })
    .from(findings)
    .innerJoin(repos, eq(repos.id, findings.repoId))
    .where(and(...where))
    .orderBy(SEVERITY_ORDER, desc(findings.lastSeenAt))
    .limit(limit);
  return rows.map(({ staleAt, sink, ...row }) => ({ ...row, sink: sink ? { file: sink.file, line: sink.line } : null, stale: staleAt !== null }));
}

/** Counts per status for the user's findings, for the filter tabs. */
export async function findingStatusCounts(database: Db, userId: string, filters: Omit<FindingFilters, "status"> = {}): Promise<Record<"open" | "fixed" | "dismissed", number>> {
  const where = findingConditions(userId, { ...filters, status: undefined });
  const rows = await database
    .select({ status: findings.status, n: sql<number>`count(*)::int` })
    .from(findings)
    .innerJoin(repos, eq(repos.id, findings.repoId))
    .where(and(...where))
    .groupBy(findings.status);
  const counts = { open: 0, fixed: 0, dismissed: 0 };
  for (const row of rows) if (row.status in counts) counts[row.status as keyof typeof counts] = row.n;
  return counts;
}

/**
 * The findings the list shows for these filters, in the same order, with
 * everything needed to copy them out as a report or a prompt.
 */
export async function findingsForExport(database: Db, userId: string, filters: FindingFilters = {}, limit = FINDING_LIST_LIMIT) {
  return database
    .select({
      id: findings.id,
      repoFullName: repos.fullName,
      defaultBranch: repos.defaultBranch,
      title: findings.title,
      severity: findings.severity,
      confidence: findings.confidence,
      category: findings.category,
      cwe: findings.cwe,
      status: findings.status,
      dismissReason: findings.dismissReason,
      impact: findings.impact,
      mitigations: findings.mitigations,
      entryPoint: findings.entryPoint,
      attackPath: findings.attackPath,
      attacker: findings.attacker,
      preconditions: findings.preconditions,
      proofOfConcept: findings.proofOfConcept,
      fixGuidance: findings.fixGuidance,
      guarantees: findings.guarantees,
      mustNotBreak: findings.mustNotBreak,
      regressionTest: findings.regressionTest,
      alsoReported: findings.alsoReported,
      prNumber: findings.prNumber,
      firstSeenAt: findings.firstSeenAt,
      lastSeenAt: findings.lastSeenAt,
      fixedAt: findings.fixedAt,
      stale: sql<boolean>`${findings.staleAt} is not null`,
    })
    .from(findings)
    .innerJoin(repos, eq(repos.id, findings.repoId))
    .where(and(...findingConditions(userId, { ...filters, status: filters.status ?? "open" })))
    .orderBy(SEVERITY_ORDER, desc(findings.lastSeenAt))
    .limit(limit);
}

export type ExportedFinding = Awaited<ReturnType<typeof findingsForExport>>[number];

// ---- Finding screen --------------------------------------------------------

/** A finding the user can see, with its history. One round trip: both queries run at once. */
export async function findingForUser(database: Db, userId: string, findingId: string) {
  const [[row], history] = await Promise.all([
    database
      .select({ finding: findings, repo: { id: repos.id, fullName: repos.fullName, private: repos.private, defaultBranch: repos.defaultBranch } })
      .from(findings)
      .innerJoin(repos, eq(repos.id, findings.repoId))
      .where(and(eq(findings.id, findingId), canSee(userId))),
    // Scoped too, so nothing about a finding the user cannot see is ever read into memory.
    database
      .select({ type: findingEvents.type, at: findingEvents.createdAt, login: users.login, scanId: findingEvents.scanId })
      .from(findingEvents)
      .innerJoin(findings, eq(findings.id, findingEvents.findingId))
      .leftJoin(users, eq(users.id, findingEvents.userId))
      .where(
        and(
          eq(findingEvents.findingId, findingId),
          sql`${findingEvents.type} <> 'prompt_copied'`,
          sql`exists (select 1 from ${permissionCache} pc where pc.user_id = ${userId} and pc.repo_id = ${findings.repoId})`,
        ),
      )
      .orderBy(desc(findingEvents.createdAt))
      .limit(30),
  ]);
  return row ? { ...row, history } : undefined;
}

export type FindingAction = { type: "dismiss"; reason: "false_positive" | "accepted_risk" | "wont_fix" } | { type: "fix" } | { type: "reopen" };

/** Code excerpts go once a finding is resolved (SPEC §6); so does the prompt that quotes them. */
const RESOLVED = {
  attackPath: sql`(select coalesce(jsonb_agg(step - 'excerpt'), '[]'::jsonb) from jsonb_array_elements(${findings.attackPath}) step)`,
  fixPrompt: "",
};

/** Applies a person's decision to a finding they can see. False if they cannot, or nothing changed. */
export async function applyFindingAction(database: Db, userId: string, findingId: string, action: FindingAction): Promise<boolean> {
  return database.transaction(async (tx) => {
    const visible = and(eq(findings.id, findingId), sql`exists (select 1 from ${permissionCache} pc where pc.user_id = ${userId} and pc.repo_id = ${findings.repoId})`);
    const update =
      action.type === "dismiss"
        ? tx.update(findings).set({ status: "dismissed", dismissReason: action.reason, ...RESOLVED }).where(and(visible, eq(findings.status, "open")))
        : action.type === "fix"
          ? tx.update(findings).set({ status: "fixed", fixedAt: new Date(), ...RESOLVED }).where(and(visible, eq(findings.status, "open")))
          : tx.update(findings).set({ status: "open", dismissReason: null, fixedAt: null }).where(and(visible, inArray(findings.status, ["fixed", "dismissed"])));
    const changed = await update.returning({ id: findings.id });
    if (changed.length === 0) return false;
    const type = action.type === "dismiss" ? "dismissed" : action.type === "fix" ? "fixed" : "reopened";
    await tx.insert(findingEvents).values({ findingId, userId, type });
    return true;
  });
}

/** Records that someone took the fix prompt (copy, deeplink or one-liner). */
export async function recordPromptCopied(database: Db, userId: string, findingId: string): Promise<void> {
  await recordPromptsCopied(database, userId, [findingId]);
}

/**
 * `recordPromptCopied` for many findings at once. Once per person and
 * finding: copying again adds nothing, so replaying the action cannot grow
 * the table. Serialised per user, so copies racing each other see the row
 * the first one wrote.
 */
export async function recordPromptsCopied(database: Db, userId: string, findingIds: string[]): Promise<void> {
  if (findingIds.length === 0) return;
  await database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${userId}, 2))`);
    await tx.execute(sql`
      insert into ${findingEvents} (finding_id, user_id, type)
      select f.id, ${userId}, 'prompt_copied'
      from ${findings} f join ${permissionCache} pc on pc.repo_id = f.repo_id and pc.user_id = ${userId}
      where f.id in (${sql.join(
        findingIds.map((id) => sql`${id}`),
        sql`, `,
      )})
        and not exists (select 1 from ${findingEvents} e where e.finding_id = f.id and e.user_id = ${userId} and e.type = 'prompt_copied')
    `);
  });
}

// ---- Scan screen -----------------------------------------------------------

/** A scan the user can see, with the findings it reported and its feed so far. One round trip. */
export async function scanForUser(database: Db, userId: string, scanId: string, options: { events?: number } = {}) {
  const visibleScan = sql`exists (select 1 from ${scans} s join ${permissionCache} pc on pc.repo_id = s.repo_id and pc.user_id = ${userId} where s.id = ${scanId})`;
  const [[row], found, events] = await Promise.all([
    database
      .select({
        scan: scans,
        repo: { id: repos.id, fullName: repos.fullName, private: repos.private },
        org: { login: orgs.githubLogin, hacker: sql<unknown>`${orgs.settings} -> 'hacker'` },
        metrics: scanMetrics,
      })
      .from(scans)
      .innerJoin(repos, eq(repos.id, scans.repoId))
      .innerJoin(orgs, eq(orgs.id, scans.orgId))
      .leftJoin(scanMetrics, eq(scanMetrics.scanId, scans.id))
      .where(and(eq(scans.id, scanId), canSee(userId))),
    // The scan's findings are listed in its stats.
    database
      .select({ id: findings.id, title: findings.title, severity: findings.severity, confidence: findings.confidence, status: findings.status, sink: sql<{ file: string; line: number } | null>`${findings.attackPath} -> -1`, morePlaces: MORE_PLACES })
      .from(findings)
      .where(and(sql`${findings.id} in (select jsonb_array_elements_text(coalesce(stats -> 'findingIds', '[]'::jsonb))::uuid from ${scans} where id = ${scanId})`, visibleScan))
      .orderBy(SEVERITY_ORDER),
    options.events
      ? database
          .select({ seq: scanEvents.seq, type: scanEvents.type, message: scanEvents.message, createdAt: scanEvents.createdAt })
          .from(scanEvents)
          .where(and(eq(scanEvents.scanId, scanId), visibleScan))
          .orderBy(scanEvents.seq)
          .limit(options.events)
      : Promise.resolve([]),
  ]);
  return row ? { ...row, findings: found, events } : undefined;
}

/** Whether the user can see a scan, without loading it. */
export async function canSeeScan(database: Db, userId: string, scanId: string): Promise<boolean> {
  const rows = await database.select({ id: scans.id }).from(scans).innerJoin(repos, eq(repos.id, scans.repoId)).where(and(eq(scans.id, scanId), canSee(userId)));
  return rows.length === 1;
}

/** The live feed's poll: new events and the scan's status, in one query. */
export async function feedSince(
  database: Db,
  scanId: string,
  afterSeq: number,
  limit = 200,
): Promise<{ status: string | null; startedAt: string | null; events: Array<{ seq: number; type: string; message: string; createdAt: string }> }> {
  const [row] = await database.execute<{ status: string | null; startedAt: string | null; events: Array<{ seq: number; type: string; message: string; createdAt: string }> }>(sql`
    select s.status, s.started_at as "startedAt",
      coalesce((select json_agg(e order by e.seq) from (
        select seq, type, message, created_at as "createdAt" from ${scanEvents}
        where scan_id = ${scanId} and seq > ${afterSeq} order by seq limit ${limit}
      ) e), '[]'::json) as events
    from (select 1) one left join ${scans} s on s.id = ${scanId}
  `);
  return { status: row?.status ?? null, startedAt: row?.startedAt ? new Date(row.startedAt).toISOString() : null, events: row?.events ?? [] };
}

// ---- Overview --------------------------------------------------------------

export interface OverviewDay {
  /** UTC date, YYYY-MM-DD. */
  day: string;
  reviews: number;
  deep: number;
  found: number;
  fixed: number;
}

export interface Overview {
  /** This window, and the window of the same length before it, for comparison. */
  now: OverviewWindow;
  before: OverviewWindow;
  open: Record<Severity, number>;
  days: OverviewDay[];
}

export interface OverviewWindow {
  /** Distinct pull requests reviewed, and the review runs behind them. */
  pullRequests: number;
  reviews: number;
  deepScans: number;
  found: number;
  fixed: number;
  /** Credits charged. */
  credits: number;
}

/**
 * The overview's numbers across every repo the user can see, over the last
 * `days` UTC days (today included), with one row per day. Two queries.
 */
export async function dashboardOverview(database: Db, userId: string, days = 30, now = new Date()): Promise<Overview> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = new Date(today - (days - 1) * 86_400_000);
  const before = new Date(since.getTime() - days * 86_400_000);
  const visible = sql`select r.id from ${repos} r join ${permissionCache} pc on pc.repo_id = r.id and pc.user_id = ${userId} where r.enabled`;
  const window = (from: Date, to: Date | null) => {
    const inWindow = (column: SQL) => (to ? sql`${column} >= ${from.toISOString()}::timestamptz and ${column} < ${to.toISOString()}::timestamptz` : sql`${column} >= ${from.toISOString()}::timestamptz`);
    return sql`json_build_object(
      'pullRequests', (select count(distinct (repo_id, pr_number)) from s where kind = 'pr_review' and status = 'completed' and ${inWindow(sql`created_at`)}),
      'reviews', (select count(*) from s where kind = 'pr_review' and status = 'completed' and ${inWindow(sql`created_at`)}),
      'deepScans', (select count(*) from s where kind = 'deep' and status = 'completed' and ${inWindow(sql`created_at`)}),
      'credits', (select coalesce(sum(credits), 0) from s where billing = 'charged' and ${inWindow(sql`created_at`)}),
      'found', (select count(*) from f where ${inWindow(sql`first_seen_at`)}),
      'fixed', (select count(*) from f where status = 'fixed' and ${inWindow(sql`fixed_at`)})
    )`;
  };
  const [[totals], series] = await Promise.all([
    database.execute<{ now: OverviewWindow; before: OverviewWindow; critical: number; high: number; medium: number; low: number }>(sql`
      with s as (select repo_id, pr_number, kind, status, credits, billing, created_at from ${scans} where repo_id in (${visible}) and created_at >= ${before.toISOString()}::timestamptz),
           f as (select severity, status, first_seen_at, fixed_at from ${findings} where repo_id in (${visible}) and confidence <> 'low')
      select ${window(since, null)} as now, ${window(before, since)} as before,
        (select count(*) from f where status = 'open' and severity = 'critical')::int as critical,
        (select count(*) from f where status = 'open' and severity = 'high')::int as high,
        (select count(*) from f where status = 'open' and severity = 'medium')::int as medium,
        (select count(*) from f where status = 'open' and severity = 'low')::int as low
    `),
    // One pass over each source, grouped by UTC day, then laid over every day of the window.
    database.execute<{ day: string; reviews: number; deep: number; found: number; fixed: number }>(sql`
      select to_char(g.d, 'YYYY-MM-DD') as day,
        coalesce(s.reviews, 0)::int as reviews, coalesce(s.deep, 0)::int as deep,
        coalesce(f.found, 0)::int as found, coalesce(x.fixed, 0)::int as fixed
      from generate_series(${utcDay(since)}::date, ${utcDay(now)}::date, interval '1 day') as g(d)
      left join (
        select (created_at at time zone 'UTC')::date as d,
          count(*) filter (where kind = 'pr_review') as reviews, count(*) filter (where kind = 'deep') as deep
        from ${scans} where repo_id in (${visible}) and status = 'completed' and kind in ('pr_review', 'deep') and created_at >= ${since.toISOString()}::timestamptz
        group by 1
      ) s on s.d = g.d
      left join (
        select (first_seen_at at time zone 'UTC')::date as d, count(*) as found
        from ${findings} where repo_id in (${visible}) and confidence <> 'low' and first_seen_at >= ${since.toISOString()}::timestamptz
        group by 1
      ) f on f.d = g.d
      left join (
        select (fixed_at at time zone 'UTC')::date as d, count(*) as fixed
        from ${findings} where repo_id in (${visible}) and confidence <> 'low' and status = 'fixed' and fixed_at >= ${since.toISOString()}::timestamptz
        group by 1
      ) x on x.d = g.d
      order by g.d
    `),
  ]);
  const count = (w: OverviewWindow): OverviewWindow => ({ pullRequests: Number(w.pullRequests), reviews: Number(w.reviews), deepScans: Number(w.deepScans), found: Number(w.found), fixed: Number(w.fixed), credits: Number(w.credits) });
  return {
    now: count(totals!.now),
    before: count(totals!.before),
    open: { critical: totals!.critical, high: totals!.high, medium: totals!.medium, low: totals!.low },
    days: series.map((row) => ({ day: row.day, reviews: row.reviews, deep: row.deep, found: row.found, fixed: row.fixed })),
  };
}

/** "2026-11-03": a moment's UTC date. */
function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ---- Scan history ----------------------------------------------------------

export interface ScanFilters {
  repoId?: string;
  orgId?: string;
  kind?: "recon" | "pr_review" | "deep" | "fix_check";
  /** Only scans created before this, for the next page. */
  before?: Date;
}

export interface ScanListItem {
  id: string;
  kind: string;
  status: string;
  prNumber: number | null;
  repoId: string;
  repoFullName: string;
  createdAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  /** Credits charged; 0 for free scans and scans that weren't charged. */
  credits: number;
  /** What the scan reported, low confidence left out. */
  found: Record<Severity, number>;
}

/** The runs the user can see, newest first, with what each found and cost. One query. */
export async function dashboardScans(database: Db, userId: string, filters: ScanFilters = {}, limit = 50): Promise<ScanListItem[]> {
  const where: SQL[] = [canSee(userId), eq(repos.enabled, true)];
  if (filters.repoId) where.push(eq(scans.repoId, filters.repoId));
  if (filters.orgId) where.push(eq(scans.orgId, filters.orgId));
  if (filters.kind) where.push(eq(scans.kind, filters.kind));
  if (filters.before) where.push(sql`${scans.createdAt} < ${filters.before.toISOString()}::timestamptz`);
  const reported = sql`${findings.id} in (select jsonb_array_elements_text(coalesce(${scans.stats} -> 'findingIds', '[]'::jsonb))::uuid) and ${findings.confidence} <> 'low'`;
  const rows = await database
    .select({
      id: scans.id,
      kind: scans.kind,
      status: scans.status,
      prNumber: scans.prNumber,
      repoId: scans.repoId,
      repoFullName: repos.fullName,
      createdAt: scans.createdAt,
      startedAt: scans.startedAt,
      finishedAt: scans.finishedAt,
      durationMs: scanMetrics.durationMs,
      credits: sql<number>`case when ${scans.billing} = 'charged' then ${scans.credits} else 0 end`,
      found: sql<Record<Severity, number>>`(select json_build_object(
        'critical', count(*) filter (where ${findings.severity} = 'critical'),
        'high', count(*) filter (where ${findings.severity} = 'high'),
        'medium', count(*) filter (where ${findings.severity} = 'medium'),
        'low', count(*) filter (where ${findings.severity} = 'low')
      ) from ${findings} where ${reported})`,
    })
    .from(scans)
    .innerJoin(repos, eq(repos.id, scans.repoId))
    .leftJoin(scanMetrics, eq(scanMetrics.scanId, scans.id))
    .where(and(...where))
    .orderBy(desc(scans.createdAt))
    .limit(limit);
  return rows.map(({ startedAt, ...row }) => ({
    ...row,
    // Scans without metrics (failed, or still running) fall back to their own clock.
    durationMs: row.durationMs ?? (startedAt && row.finishedAt ? row.finishedAt.getTime() - startedAt.getTime() : null),
    credits: Number(row.credits),
  }));
}

// ---- Hackers ----------------------------------------------------------------

export interface UserHacker {
  orgId: string;
  login: string;
  /** The org's hacker as stored, unchecked; null before it recruits one. */
  hacker: unknown;
  /** Whether the user may change it. */
  admin: boolean;
  /** Whether a scan the user can see is under way. */
  working: boolean;
}

/**
 * The hackers a user works with: one per installed org they administer or can
 * see a repository in. Recruited ones first, then the orgs they administer,
 * then by name. One query, starting from the person's own rows (both lookups
 * lead with user_id), so it costs the same however many orgs there are.
 */
export async function userHackers(database: Db, userId: string): Promise<UserHacker[]> {
  const rows = await database.execute<{ id: string; login: string; hacker: unknown; admin: boolean; working: boolean }>(sql`
    select o.id, o.github_login as login, o.settings -> 'hacker' as hacker,
      exists (select 1 from ${orgAdmins} oa where oa.user_id = ${userId} and oa.org_id = o.id) as admin,
      exists (
        select 1 from ${scans} s join ${permissionCache} pc on pc.repo_id = s.repo_id and pc.user_id = ${userId}
        where s.org_id = o.id and s.status in ('queued', 'running', 'publishing')
      ) as working
    from ${orgs} o
    join (
      select oa.org_id from ${orgAdmins} oa where oa.user_id = ${userId}
      union
      select r.org_id from ${permissionCache} pc join ${repos} r on r.id = pc.repo_id where pc.user_id = ${userId} and r.enabled
    ) mine on mine.org_id = o.id
    where o.installation_id is not null
    order by (o.settings ? 'hacker') desc, 4 desc, o.github_login
  `);
  return rows.map((row) => ({ orgId: row.id, login: row.login, hacker: row.hacker ?? null, admin: row.admin, working: row.working }));
}

export interface HackerRecord {
  /** Completed scans of each kind. */
  jobs: { deep: number; reviews: number; other: number };
  /** Lines read across completed scans. */
  lines: number;
  /** Findings reported, low confidence left out, and how many are fixed and open. */
  found: number;
  fixed: number;
  open: number;
  /** The first scan's time: when they started work. */
  since: Date | null;
  /** The scan under way, if any: the newest one queued or running. */
  active: { id: string; kind: string; status: string; repoFullName: string } | null;
}

/** What an org's hacker has done, over the repositories the user can see. One query. */
export async function hackerRecord(database: Db, userId: string, orgId: string): Promise<HackerRecord> {
  const visible = sql`select r.id from ${repos} r join ${permissionCache} pc on pc.repo_id = r.id and pc.user_id = ${userId} where r.enabled and r.org_id = ${orgId}`;
  const [row] = await database.execute<{
    deep: number;
    reviews: number;
    other: number;
    lines: string | null;
    since: string | null;
    found: number;
    fixed: number;
    open: number;
    active: { id: string; kind: string; status: string; repoFullName: string } | null;
  }>(sql`
    with s as (select id, repo_id, kind, status, stats, created_at from ${scans} where org_id = ${orgId} and repo_id in (${visible})),
         f as (select status from ${findings} where repo_id in (${visible}) and confidence <> 'low')
    select
      (select count(*) from s where status = 'completed' and kind = 'deep')::int as deep,
      (select count(*) from s where status = 'completed' and kind = 'pr_review')::int as reviews,
      (select count(*) from s where status = 'completed' and kind not in ('deep', 'pr_review'))::int as other,
      (select sum((stats ->> 'loc')::bigint) from s where status = 'completed') as lines,
      (select min(created_at) from s) as since,
      (select count(*) from f)::int as found,
      (select count(*) from f where status = 'fixed')::int as fixed,
      (select count(*) from f where status = 'open')::int as open,
      (select json_build_object('id', s.id, 'kind', s.kind, 'status', s.status, 'repoFullName', r.full_name)
        from s join ${repos} r on r.id = s.repo_id
        where s.status in ('queued', 'running', 'publishing') order by s.created_at desc limit 1) as active
  `);
  return {
    jobs: { deep: row?.deep ?? 0, reviews: row?.reviews ?? 0, other: row?.other ?? 0 },
    lines: Number(row?.lines ?? 0),
    found: row?.found ?? 0,
    fixed: row?.fixed ?? 0,
    open: row?.open ?? 0,
    since: row?.since ? new Date(row.since) : null,
    active: row?.active ?? null,
  };
}

// ---- Settings --------------------------------------------------------------

export interface SettingsOrg {
  id: string;
  login: string;
  type: "User" | "Organization";
  installationId: number | null;
  settings: OrgSettings;
  admin: boolean;
  /** The org's billing as last read from Autumn; null if never read. */
  billing: typeof orgBilling.$inferSelect | null;
  repos: Array<{ id: string; fullName: string; private: boolean }>;
}

/** Orgs where the user can see a repo or is an admin, with the repos they can see. */
export async function settingsOrgs(database: Db, userId: string): Promise<SettingsOrg[]> {
  const [visible, admin] = await Promise.all([
    database
      .select({ org: orgs, billing: orgBilling, repo: { id: repos.id, fullName: repos.fullName, private: repos.private } })
      .from(repos)
      .innerJoin(orgs, eq(orgs.id, repos.orgId))
      .leftJoin(orgBilling, eq(orgBilling.orgId, orgs.id))
      .where(and(eq(repos.enabled, true), canSee(userId)))
      .orderBy(repos.fullName),
    database
      .select({ org: orgs, billing: orgBilling })
      .from(orgAdmins)
      .innerJoin(orgs, eq(orgs.id, orgAdmins.orgId))
      .leftJoin(orgBilling, eq(orgBilling.orgId, orgs.id))
      .where(eq(orgAdmins.userId, userId)),
  ]);
  const byId = new Map<string, SettingsOrg>();
  const add = (org: typeof orgs.$inferSelect, billing: typeof orgBilling.$inferSelect | null) => {
    let entry = byId.get(org.id);
    if (!entry) byId.set(org.id, (entry = { id: org.id, login: org.githubLogin, type: org.type, installationId: org.installationId, settings: org.settings, admin: false, billing, repos: [] }));
    return entry;
  };
  for (const { org, billing } of admin) add(org, billing).admin = true;
  for (const { org, billing, repo } of visible) add(org, billing).repos.push(repo);
  return [...byId.values()].filter((org) => org.installationId !== null).sort((a, b) => a.login.localeCompare(b.login));
}

/** Changes an org's settings if the user is its admin. False otherwise. */
export async function updateOrgSettings(database: Db, userId: string, orgId: string, patch: Partial<OrgSettings>): Promise<boolean> {
  const rows = await database
    .update(orgs)
    .set({ settings: sql`${orgs.settings} || ${JSON.stringify(patch)}::jsonb` })
    .where(and(eq(orgs.id, orgId), sql`exists (select 1 from ${orgAdmins} oa where oa.user_id = ${userId} and oa.org_id = ${orgs.id})`))
    .returning({ id: orgs.id });
  return rows.length === 1;
}

// ---- Notifications ---------------------------------------------------------

/** Reserves a scan's notifications. Exactly one caller gets true. */
export async function claimNotification(database: Db, scanId: string): Promise<boolean> {
  const rows = await database.update(scans).set({ notifiedAt: new Date() }).where(and(eq(scans.id, scanId), isNull(scans.notifiedAt))).returning({ id: scans.id });
  return rows.length === 1;
}

/**
 * Who hears about a repo: people who signed in and had push access when
 * GitHub was last asked, within 30 days. No-reply placeholders are skipped.
 */
export async function notificationRecipients(database: Db, repoId: string): Promise<string[]> {
  const rows = await database
    .selectDistinct({ email: users.email })
    .from(permissionCache)
    .innerJoin(users, eq(users.id, permissionCache.userId))
    .where(and(eq(permissionCache.repoId, repoId), sql`${permissionCache.checkedAt} > now() - interval '30 days'`, sql`${users.email} not like '%@users.noreply.github.com'`));
  return rows.map((row) => row.email);
}
