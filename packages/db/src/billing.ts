/**
 * Billing's database side: a copy of each org's Autumn state for display,
 * the credits each scan holds, and starting recon once an org has a plan.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import { creditClaims, orgAdmins, orgBilling, orgNotices, orgs, repoMemory, repos, scans, users } from "./schema";

export type OrgBillingRow = typeof orgBilling.$inferSelect;
export type OrgBillingInput = Omit<OrgBillingRow, "orgId" | "activatedAt" | "checkedAt" | "creditLevel" | "creditLevelAt" | "creditLevelRev">;

/** Raw SQL parameters take strings, not Dates. */
const iso = (date: Date | null) => (date ? date.toISOString() : null);

export async function orgBillingRow(database: Db, orgId: string): Promise<OrgBillingRow | undefined> {
  return database.query.orgBilling.findFirst({ where: eq(orgBilling.orgId, orgId) });
}

/**
 * Stores what Autumn reported. Returns the plan before this write and whether
 * this is the first time the org was seen with a plan.
 */
export async function saveOrgBilling(database: Db, orgId: string, state: OrgBillingInput, at = new Date()): Promise<{ previousPlanId: string | null; firstActivation: boolean }> {
  const values = { ...state, checkedAt: at };
  const activatedAt = state.planId ? at : null;
  const [row] = (await database.execute<{ previous_plan_id: string | null; first: boolean }>(sql`
    with previous as (select plan_id, activated_at from ${orgBilling} where org_id = ${orgId}),
    saved as (
      insert into ${orgBilling} (org_id, plan_id, past_due, ends_at, renews_at, next_plan_id, credits, credits_reset_at, auto_top_up, activated_at, checked_at)
      values (${orgId}, ${values.planId}, ${values.pastDue}, ${iso(values.endsAt)}::timestamptz, ${iso(values.renewsAt)}::timestamptz, ${values.nextPlanId}, ${values.credits},
              ${iso(values.creditsResetAt)}::timestamptz, ${values.autoTopUp ? JSON.stringify(values.autoTopUp) : null}::jsonb, ${iso(activatedAt)}::timestamptz, ${iso(at)}::timestamptz)
      on conflict (org_id) do update set
        plan_id = excluded.plan_id, past_due = excluded.past_due, ends_at = excluded.ends_at, renews_at = excluded.renews_at,
        next_plan_id = excluded.next_plan_id, credits = excluded.credits, credits_reset_at = excluded.credits_reset_at,
        auto_top_up = excluded.auto_top_up, checked_at = excluded.checked_at,
        activated_at = coalesce(${orgBilling.activatedAt}, excluded.activated_at)
      returning activated_at
    )
    select (select plan_id from previous) as previous_plan_id,
           ((select activated_at from previous) is null and (select activated_at from saved) is not null) as first
  `)) as unknown as Array<{ previous_plan_id: string | null; first: boolean }>;
  return { previousPlanId: row?.previous_plan_id ?? null, firstActivation: !!row?.first };
}

/** Records the balance a reservation reported, without waiting for a full refresh. Returns the org's billing after it. */
export async function setOrgCredits(database: Db, orgId: string, credits: number): Promise<OrgBillingRow | undefined> {
  const [row] = await database.update(orgBilling).set({ credits }).where(eq(orgBilling.orgId, orgId)).returning();
  return row;
}

/** Makes the next page view read Autumn again (after a purchase or a charge). */
export async function staleOrgBilling(database: Db, orgId: string): Promise<void> {
  await database.update(orgBilling).set({ checkedAt: new Date(0) }).where(eq(orgBilling.orgId, orgId));
}

/** The org if the user is its admin (GitHub org admin, or the personal account's owner). */
export async function orgForAdmin(database: Db, userId: string, orgId: string) {
  const [row] = await database
    .select({ org: orgs, billing: orgBilling })
    .from(orgAdmins)
    .innerJoin(orgs, eq(orgs.id, orgAdmins.orgId))
    .leftJoin(orgBilling, eq(orgBilling.orgId, orgs.id))
    .where(and(eq(orgAdmins.userId, userId), eq(orgAdmins.orgId, orgId)));
  return row;
}

/**
 * Queues recon for every enabled repo that has no threat model and no recon
 * on the way, once an org has a plan. Serialised per org, so two callers
 * never queue the same repo twice. Returns the new scans.
 */
export async function queuePendingRecons(database: Db, orgId: string): Promise<string[]> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orgId}, 1))`);
    const pending = await tx
      .select({ id: repos.id })
      .from(repos)
      .leftJoin(repoMemory, eq(repoMemory.repoId, repos.id))
      .where(
        and(
          eq(repos.orgId, orgId),
          eq(repos.enabled, true),
          isNull(repoMemory.repoId),
          sql`not exists (select 1 from ${scans} s where s.repo_id = ${repos.id} and s.kind = 'recon' and s.status in ('queued', 'running', 'publishing', 'completed'))`,
        ),
      );
    if (pending.length === 0) return [];
    const created = await tx
      .insert(scans)
      .values(pending.map((repo) => ({ repoId: repo.id, orgId, kind: "recon" as const, trigger: "webhook" as const, headSha: "HEAD" })))
      .returning({ id: scans.id });
    return created.map((scan) => scan.id);
  });
}

// ---- Free credits ------------------------------------------------------------

export type CreditClaimRow = typeof creditClaims.$inferSelect;

/**
 * Why a claim can't go ahead: the account or the person has claimed already
 * (`org_claimed`, `user_claimed`), or every claim is gone (`exhausted`).
 * `resume` is this person's own claim for this account, not finished yet (or
 * finished: every step after it is safe to repeat).
 */
export type CreditClaimStart = "new" | "resume" | "org_claimed" | "user_claimed" | "exhausted";

/**
 * Takes the account's one claim for this person, unless it or they have one
 * already or `limit` claims have been made. Serialised, so two claims at once
 * can neither both pass the limit nor both take the same account or person.
 */
export async function startCreditClaim(
  database: Db,
  claim: { githubAccountId: number; githubUserId: number; orgId: string; userId: string; credits: number },
  limit: number,
): Promise<CreditClaimStart> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('credit_claims', 0))`);
    const existing = await tx
      .select()
      .from(creditClaims)
      .where(or(eq(creditClaims.githubAccountId, claim.githubAccountId), eq(creditClaims.githubUserId, claim.githubUserId)));
    const own = existing.find((row) => row.githubAccountId === claim.githubAccountId && row.githubUserId === claim.githubUserId);
    if (own) return "resume";
    if (existing.some((row) => row.githubAccountId === claim.githubAccountId)) return "org_claimed";
    if (existing.length > 0) return "user_claimed";
    const [{ count } = { count: 0 }] = await tx.select({ count: sql<number>`count(*)::int` }).from(creditClaims);
    if (count >= limit) return "exhausted";
    await tx.insert(creditClaims).values(claim);
    return "new";
  });
}

/** Records that Autumn holds the claim's credits and the free plan. */
export async function finishCreditClaim(database: Db, githubAccountId: number): Promise<void> {
  await database.update(creditClaims).set({ grantedAt: new Date() }).where(and(eq(creditClaims.githubAccountId, githubAccountId), isNull(creditClaims.grantedAt)));
}

/** The claims touching this account or this person, and how many have been made in all. */
export async function creditClaimState(database: Db, githubAccountIds: number[], githubUserId: number | null): Promise<{ claims: CreditClaimRow[]; total: number }> {
  const where = or(
    githubAccountIds.length ? inArray(creditClaims.githubAccountId, githubAccountIds) : undefined,
    githubUserId !== null ? eq(creditClaims.githubUserId, githubUserId) : undefined,
  );
  const [claims, [{ total } = { total: 0 }]] = await Promise.all([
    where ? database.select().from(creditClaims).where(where) : Promise.resolve([]),
    database.select({ total: sql<number>`count(*)::int` }).from(creditClaims),
  ]);
  return { claims, total };
}

// ---- Billing emails ----------------------------------------------------------

/**
 * When a balance was true: Autumn answered sometime between the request
 * leaving (`from`) and the answer arriving (`to`).
 */
export interface BalanceSeen {
  from: Date;
  to: Date;
}

/**
 * Applies one observed balance to the org's credit level (0 ok, 1 low,
 * 2 exhausted), in one transaction under the org's row lock, so observations
 * for an org take turns. True only when this call recorded an upward crossing
 * and reserved its email: the caller sends it after the commit.
 *
 * - Fresh: answers from Autumn can arrive out of order, so an observation
 *   counts only if it was asked for (`from`) strictly after the last counted
 *   one was answered (`credit_level_at`). A tie is stale either way; a
 *   crossing it would have announced is announced by the next balance, and
 *   every reservation, charge and refusal produces one.
 * - Up: recorded only when `announce` (there is someone to tell). Then the
 *   level, its timestamp and revision move, and the email is reserved in
 *   `org_notices` in the same transaction. Without anyone to tell nothing
 *   changes, so a later balance can still announce it.
 * - Same or down: the level and its timestamp are stored, re-arming the
 *   emails for the levels above.
 */
export async function recordCreditLevel(database: Db, orgId: string, level: number, seen: BalanceSeen, announce: boolean): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [row] = await tx
      .select({ level: orgBilling.creditLevel, at: orgBilling.creditLevelAt, rev: orgBilling.creditLevelRev })
      .from(orgBilling)
      .where(eq(orgBilling.orgId, orgId))
      .for("update");
    if (!row || (row.at && seen.from <= row.at)) return false;
    const up = level > row.level;
    if (up && !announce) return false;
    await tx
      .update(orgBilling)
      .set({ creditLevel: level, creditLevelAt: seen.to, creditLevelRev: row.rev + 1 })
      .where(eq(orgBilling.orgId, orgId));
    if (!up) return false;
    const claimed = await tx
      .insert(orgNotices)
      .values({ orgId, key: `credits:${level}:${row.rev + 1}` })
      .onConflictDoNothing()
      .returning({ key: orgNotices.key });
    return claimed.length === 1;
  });
}

/** Reserves an org-wide email by a stable key. Exactly one caller gets true. */
export async function claimOrgNotice(database: Db, orgId: string, key: string): Promise<boolean> {
  const rows = await database.insert(orgNotices).values({ orgId, key }).onConflictDoNothing().returning({ key: orgNotices.key });
  return rows.length === 1;
}

/** How long an `org_admins` row is trusted: the same 30 days as access for finding emails. */
export const ADMIN_FRESH_DAYS = 30;

export interface OrgAdminContact {
  userId: string;
  email: string;
  login: string | null;
  githubUserId: number | null;
  /** GitHub confirmed them as an admin within the last 30 days. */
  fresh: boolean;
}

/**
 * The org's admins with a real address (no-reply placeholders are skipped),
 * each marked fresh or not. A row is only refreshed when that person visits
 * the dashboard (dashboard access is the only writer), so a stale one may be
 * someone GitHub no longer counts as an admin. Callers decide what a stale
 * admin may hear.
 */
export async function orgAdminContacts(database: Db, orgId: string): Promise<OrgAdminContact[]> {
  return database
    .select({
      userId: users.id,
      email: users.email,
      login: users.login,
      githubUserId: users.githubUserId,
      fresh: sql<boolean>`${orgAdmins.checkedAt} > now() - make_interval(days => ${ADMIN_FRESH_DAYS})`,
    })
    .from(orgAdmins)
    .innerJoin(users, eq(users.id, orgAdmins.userId))
    .where(and(eq(orgAdmins.orgId, orgId), sql`${users.email} not like '%@users.noreply.github.com'`));
}

// ---- Scan credits ------------------------------------------------------------

/** Records a reservation. False if the scan already holds one (a retried step). */
export async function markScanReserved(database: Db, scanId: string, credits: number): Promise<boolean> {
  const rows = await database
    .update(scans)
    .set({ billing: "reserved", creditsReserved: credits })
    .where(and(eq(scans.id, scanId), isNull(scans.billing)))
    .returning({ id: scans.id });
  return rows.length === 1;
}

/** Moves a reservation to charged or released. False if it was not reserved (already settled, or free). */
export async function settleScan(database: Db, scanId: string, outcome: "charged" | "released", credits = 0): Promise<boolean> {
  const rows = await database
    .update(scans)
    .set({ billing: outcome, credits: outcome === "charged" ? credits : 0 })
    .where(and(eq(scans.id, scanId), eq(scans.billing, "reserved")))
    .returning({ id: scans.id });
  return rows.length === 1;
}

/** Ended scans still holding credits: completed ones to charge, the rest to release. Run by the sweep. */
export async function unsettledScans(database: Db, limit = 50) {
  return database
    .select({ id: scans.id, orgId: scans.orgId, status: scans.status, billing: scans.billing, credits: scans.credits, creditsReserved: scans.creditsReserved })
    .from(scans)
    .where(and(eq(scans.billing, "reserved"), inArray(scans.status, ["completed", "failed", "cancelled", "refused"])))
    .limit(limit);
}

/**
 * Gives a Dig the org's free first deep scan if it is still to come. The org
 * row is locked first and the scan it names is read afterwards (a fresh
 * snapshot), so two Digs at once cannot both have it. Used up while that scan
 * is queued, running or completed; free again if it failed, was refused or is
 * gone. True if `scanId` is (now) the free one.
 */
export async function claimFreeDig(database: Db, orgId: string, scanId: string): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [org] = await tx.execute<{ free_dig_scan_id: string | null }>(sql`select free_dig_scan_id from ${orgs} where id = ${orgId} for update`);
    if (!org) return false;
    if (org.free_dig_scan_id === scanId) return true;
    if (org.free_dig_scan_id) {
      const [held] = await tx.execute(sql`select 1 from ${scans} where id = ${org.free_dig_scan_id} and status in ('queued', 'running', 'publishing', 'completed')`);
      if (held) return false;
    }
    await tx.update(orgs).set({ freeDigScanId: scanId }).where(eq(orgs.id, orgId));
    return true;
  });
}
