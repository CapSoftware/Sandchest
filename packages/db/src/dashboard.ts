/**
 * What the dashboard reads and writes. Every read is scoped to a user through
 * `permission_cache`, which the web app refreshes from GitHub before it is
 * trusted (SPEC §3): a row there means GitHub reported push access or higher.
 */
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "./client";
import { accounts, sessions, findingEvents, findings, orgAdmins, orgs, permissionCache, repos, scanEvents, scanMetrics, scans, users, type OrgSettings } from "./schema";

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

/** Replaces everything a user may see with what GitHub just reported. */
export async function replaceAccess(database: Db, userId: string, access: { repos: Array<{ repoId: string; permission: RepoPermission }>; adminOrgIds: string[] }, at = new Date()): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.delete(permissionCache).where(eq(permissionCache.userId, userId));
    await tx.delete(orgAdmins).where(eq(orgAdmins.userId, userId));
    if (access.repos.length > 0) await tx.insert(permissionCache).values(access.repos.map((repo) => ({ userId, ...repo, checkedAt: at })));
    if (access.adminOrgIds.length > 0) await tx.insert(orgAdmins).values(access.adminOrgIds.map((orgId) => ({ userId, orgId, checkedAt: at })));
    await tx.update(users).set({ accessCheckedAt: at }).where(eq(users.id, userId));
  });
}

/** The signed-in person for a session token, in one query. Expired sessions return nothing. */
export async function sessionUser(database: Db, token: string): Promise<{ id: string; name: string; login: string | null; image: string | null; accessCheckedAt: Date | null } | undefined> {
  const [row] = await database
    .select({ id: users.id, name: users.name, login: users.login, image: users.image, accessCheckedAt: users.accessCheckedAt })
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
  orgLogin: string;
  loc: number | null;
  lastDeepScanAt: Date | null;
  open: Record<Severity, number>;
  lastScan: { id: string; kind: string; status: string; at: Date } | null;
  activeDeepScanId: string | null;
}

/** Enabled repos the user can see, with open findings by severity and their latest scan. One query. */
export async function dashboardRepos(database: Db, userId: string): Promise<DashboardRepo[]> {
  const rows = await database.execute<{
    id: string;
    full_name: string;
    private: boolean;
    org_login: string;
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
  }>(sql`
    select r.id, r.full_name, r.private, o.github_login as org_login, r.loc, r.last_deep_scan_at,
      coalesce(f.critical, 0)::int as critical, coalesce(f.high, 0)::int as high,
      coalesce(f.medium, 0)::int as medium, coalesce(f.low, 0)::int as low,
      s.id as scan_id, s.kind as scan_kind, s.status as scan_status, coalesce(s.finished_at, s.started_at, s.created_at) as scan_at,
      d.id as active_deep_id
    from ${repos} r
    join ${orgs} o on o.id = r.org_id
    join ${permissionCache} pc on pc.repo_id = r.id and pc.user_id = ${userId}
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
      select id from ${scans} where repo_id = r.id and kind = 'deep' and status in ('queued', 'running', 'publishing') limit 1
    ) d on true
    where r.enabled
    order by coalesce(f.critical, 0) desc, coalesce(f.high, 0) desc, coalesce(f.medium, 0) desc, r.full_name
  `);
  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    private: row.private,
    orgLogin: row.org_login,
    loc: row.loc,
    lastDeepScanAt: row.last_deep_scan_at ? new Date(row.last_deep_scan_at) : null,
    open: { critical: row.critical, high: row.high, medium: row.medium, low: row.low },
    lastScan: row.scan_id ? { id: row.scan_id, kind: row.scan_kind!, status: row.scan_status!, at: new Date(row.scan_at!) } : null,
    activeDeepScanId: row.active_deep_id,
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
  sourceKind: string;
  prNumber: number | null;
  lastSeenAt: Date;
  stale: boolean;
}

const SEVERITY_ORDER = sql`case ${findings.severity} when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`;

export async function dashboardFindings(database: Db, userId: string, filters: FindingFilters = {}, limit = 300): Promise<FindingListItem[]> {
  const where: SQL[] = [canSee(userId), eq(repos.enabled, true), eq(findings.status, filters.status ?? "open")];
  if (filters.repoId) where.push(eq(findings.repoId, filters.repoId));
  if (filters.severities?.length) where.push(inArray(findings.severity, filters.severities));
  if (!filters.includeLowConfidence) where.push(sql`${findings.confidence} <> 'low'`);
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
  const where: SQL[] = [canSee(userId), eq(repos.enabled, true)];
  if (filters.repoId) where.push(eq(findings.repoId, filters.repoId));
  if (filters.severities?.length) where.push(inArray(findings.severity, filters.severities));
  if (!filters.includeLowConfidence) where.push(sql`${findings.confidence} <> 'low'`);
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
  await database.execute(sql`
    insert into ${findingEvents} (finding_id, user_id, type)
    select ${findingId}, ${userId}, 'prompt_copied'
    where exists (select 1 from ${findings} f join ${permissionCache} pc on pc.repo_id = f.repo_id and pc.user_id = ${userId} where f.id = ${findingId})
  `);
}

// ---- Scan screen -----------------------------------------------------------

/** A scan the user can see, with the findings it reported and its feed so far. One round trip. */
export async function scanForUser(database: Db, userId: string, scanId: string, options: { events?: number } = {}) {
  const visibleScan = sql`exists (select 1 from ${scans} s join ${permissionCache} pc on pc.repo_id = s.repo_id and pc.user_id = ${userId} where s.id = ${scanId})`;
  const [[row], found, events] = await Promise.all([
    database
      .select({ scan: scans, repo: { id: repos.id, fullName: repos.fullName, private: repos.private }, metrics: scanMetrics })
      .from(scans)
      .innerJoin(repos, eq(repos.id, scans.repoId))
      .leftJoin(scanMetrics, eq(scanMetrics.scanId, scans.id))
      .where(and(eq(scans.id, scanId), canSee(userId))),
    // The scan's findings are listed in its stats.
    database
      .select({ id: findings.id, title: findings.title, severity: findings.severity, confidence: findings.confidence, status: findings.status, sink: sql<{ file: string; line: number } | null>`${findings.attackPath} -> -1` })
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
export async function feedSince(database: Db, scanId: string, afterSeq: number, limit = 200): Promise<{ status: string | null; events: Array<{ seq: number; type: string; message: string; createdAt: string }> }> {
  const [row] = await database.execute<{ status: string | null; events: Array<{ seq: number; type: string; message: string; createdAt: string }> }>(sql`
    select (select status from ${scans} where id = ${scanId}) as status,
      coalesce((select json_agg(e order by e.seq) from (
        select seq, type, message, created_at as "createdAt" from ${scanEvents}
        where scan_id = ${scanId} and seq > ${afterSeq} order by seq limit ${limit}
      ) e), '[]'::json) as events
  `);
  return { status: row?.status ?? null, events: row?.events ?? [] };
}

export async function recentScans(database: Db, userId: string, repoId: string, limit = 8) {
  return database
    .select({ id: scans.id, kind: scans.kind, status: scans.status, prNumber: scans.prNumber, createdAt: scans.createdAt, finishedAt: scans.finishedAt })
    .from(scans)
    .innerJoin(repos, eq(repos.id, scans.repoId))
    .where(and(eq(scans.repoId, repoId), canSee(userId)))
    .orderBy(desc(scans.createdAt))
    .limit(limit);
}

// ---- Settings --------------------------------------------------------------

export interface SettingsOrg {
  id: string;
  login: string;
  type: "User" | "Organization";
  installationId: number | null;
  settings: OrgSettings;
  admin: boolean;
  repos: Array<{ id: string; fullName: string; private: boolean }>;
}

/** Orgs where the user can see a repo or is an admin, with the repos they can see. */
export async function settingsOrgs(database: Db, userId: string): Promise<SettingsOrg[]> {
  const [visible, admin] = await Promise.all([
    database
      .select({ org: orgs, repo: { id: repos.id, fullName: repos.fullName, private: repos.private } })
      .from(repos)
      .innerJoin(orgs, eq(orgs.id, repos.orgId))
      .where(and(eq(repos.enabled, true), canSee(userId)))
      .orderBy(repos.fullName),
    database.select({ org: orgs }).from(orgAdmins).innerJoin(orgs, eq(orgs.id, orgAdmins.orgId)).where(eq(orgAdmins.userId, userId)),
  ]);
  const byId = new Map<string, SettingsOrg>();
  const add = (org: typeof orgs.$inferSelect) => {
    let entry = byId.get(org.id);
    if (!entry) byId.set(org.id, (entry = { id: org.id, login: org.githubLogin, type: org.type, installationId: org.installationId, settings: org.settings, admin: false, repos: [] }));
    return entry;
  };
  for (const { org } of admin) add(org).admin = true;
  for (const { org, repo } of visible) add(org).repos.push(repo);
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
