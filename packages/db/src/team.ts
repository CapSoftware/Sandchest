/**
 * Teams: people an org's admins invite, on top of everyone GitHub already
 * lets in. A member sees every enabled repo of the org through the same
 * `permission_cache` rows every read is scoped by (`via` "invite"), so no
 * screen, API call or email needs to know about members.
 *
 * Access rows for one person are only ever rewritten under a lock on their
 * user row (`lockUser`): reading access from GitHub, joining and leaving
 * can't interleave, so leaving never leaves rows behind.
 */
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Db } from "./client";
import { orgAdmins, orgInvites, orgMembers, orgs, permissionCache, repos, users } from "./schema";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** How long an invite link works. */
export const INVITE_TTL_DAYS = 7;
/** Invites one person may send in a day, across every org. */
export const INVITES_PER_DAY = 50;
/** Times one invitee may be sent an invite to the same org in an hour. */
export const INVITES_PER_INVITEE_HOUR = 3;
/** Pending invites an org may hold at once. */
export const PENDING_INVITES_PER_ORG = 100;
/** Invite emails one address may receive in a day, from every org together: the mailer can't be pointed at a stranger. */
export const INVITES_PER_ADDRESS_DAY = 3;

export type Invitee = { email: string } | { githubUserId: number; githubLogin: string };

/** Serialises everything that rewrites one person's access rows. */
export async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select 1 from ${users} where id = ${userId} for update`);
}

/** Gives a member every enabled repo of the org, where GitHub hasn't already. */
async function grantOrg(tx: Tx, userId: string, orgId: string, at: Date): Promise<void> {
  await tx.execute(sql`
    insert into ${permissionCache} (user_id, repo_id, permission, via, checked_at)
    select ${userId}, r.id, 'write', 'invite', ${at.toISOString()}::timestamptz from ${repos} r where r.org_id = ${orgId} and r.enabled
    on conflict (user_id, repo_id) do nothing
  `);
}

/** Re-adds the rows a person's memberships give, after their GitHub rows were replaced. Part of `replaceAccess`. */
export async function grantMemberships(tx: Tx, userId: string, at: Date): Promise<void> {
  await tx.execute(sql`
    insert into ${permissionCache} (user_id, repo_id, permission, via, checked_at)
    select ${userId}, r.id, 'write', 'invite', ${at.toISOString()}::timestamptz
    from ${orgMembers} m
    join ${orgs} o on o.id = m.org_id and o.installation_id is not null
    join ${repos} r on r.org_id = m.org_id and r.enabled
    where m.user_id = ${userId}
    on conflict (user_id, repo_id) do nothing
  `);
}

const isAdmin = (userId: string, orgId: string | SQL | typeof orgs.id | typeof orgInvites.orgId) => sql`exists (select 1 from ${orgAdmins} oa where oa.user_id = ${userId} and oa.org_id = ${orgId})`;

// ---- Reading -----------------------------------------------------------------

export interface TeamPerson {
  userId: string;
  name: string;
  login: string | null;
  image: string | null;
  /** Can change the org's settings (GitHub says so). */
  admin: boolean;
  /** Joined by invite; an admin can remove them. */
  member: boolean;
  /** Can push to at least one of the org's repos on GitHub. */
  github: boolean;
  /** When they joined by invite. */
  joinedAt: Date | null;
}

export interface TeamInvite {
  id: string;
  email: string | null;
  githubLogin: string | null;
  invitedBy: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface OrgTeam {
  people: TeamPerson[];
  invites: TeamInvite[];
}

/**
 * Everyone with access to each org the user administers, and its pending
 * invites (expired ones too, so they can be sent again). Two queries
 * however many orgs. Orgs the user doesn't administer are left out.
 */
export async function adminTeams(database: Db, userId: string): Promise<Map<string, OrgTeam>> {
  const [people, invites] = await Promise.all([
    database.execute<{ org_id: string; user_id: string; name: string; login: string | null; image: string | null; admin: boolean; member: boolean; github: boolean; joined_at: string | null }>(sql`
      with mine as (select org_id from ${orgAdmins} where user_id = ${userId})
      select x.org_id, u.id as user_id, u.name, u.login, u.image,
        bool_or(x.kind = 'admin') as admin, bool_or(x.kind = 'member') as member, bool_or(x.kind = 'github') as github,
        max(x.joined_at) as joined_at
      from (
        select oa.org_id, oa.user_id, 'admin' as kind, null::timestamptz as joined_at from ${orgAdmins} oa where oa.org_id in (select org_id from mine)
        union all
        select m.org_id, m.user_id, 'member', m.created_at from ${orgMembers} m where m.org_id in (select org_id from mine)
        union all
        select distinct r.org_id, pc.user_id, 'github', null::timestamptz from ${permissionCache} pc
          join ${repos} r on r.id = pc.repo_id and r.enabled
          where pc.via = 'github' and r.org_id in (select org_id from mine)
      ) x
      join ${users} u on u.id = x.user_id
      group by x.org_id, u.id
      order by bool_or(x.kind = 'admin') desc, lower(coalesce(u.login, u.name))
    `),
    database.execute<{ id: string; org_id: string; email: string | null; github_login: string | null; invited_by: string | null; created_at: string; expires_at: string }>(sql`
      select i.id, i.org_id, i.email, i.github_login, coalesce(u.login, u.name) as invited_by, i.created_at, i.expires_at
      from ${orgInvites} i
      left join ${users} u on u.id = i.invited_by
      where i.accepted_at is null and i.revoked_at is null and ${isAdmin(userId, sql`i.org_id`)}
      order by i.created_at desc
    `),
  ]);
  const teams = new Map<string, OrgTeam>();
  const team = (orgId: string) => {
    let entry = teams.get(orgId);
    if (!entry) teams.set(orgId, (entry = { people: [], invites: [] }));
    return entry;
  };
  for (const row of people) {
    team(row.org_id).people.push({
      userId: row.user_id,
      name: row.name,
      login: row.login,
      image: row.image,
      admin: row.admin,
      member: row.member,
      github: row.github,
      joinedAt: row.joined_at ? new Date(row.joined_at) : null,
    });
  }
  for (const row of invites) {
    team(row.org_id).invites.push({ id: row.id, email: row.email, githubLogin: row.github_login, invitedBy: row.invited_by, createdAt: new Date(row.created_at), expiresAt: new Date(row.expires_at) });
  }
  return teams;
}

/** Orgs the user joined by invite. */
export async function memberOrgIds(database: Db, userId: string): Promise<Set<string>> {
  const rows = await database.select({ orgId: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.userId, userId));
  return new Set(rows.map((row) => row.orgId));
}

export interface InviteDetails {
  id: string;
  orgId: string;
  orgLogin: string;
  orgType: "User" | "Organization";
  installed: boolean;
  email: string | null;
  githubUserId: number | null;
  githubLogin: string | null;
  inviterLogin: string | null;
  expiresAt: Date;
  /** Neither accepted nor revoked (it may still have expired). */
  pending: boolean;
}

/** An invite by its link's token hash, whatever its state. */
export async function inviteByTokenHash(database: Db, tokenHash: string): Promise<InviteDetails | undefined> {
  const [row] = await database
    .select({
      id: orgInvites.id,
      orgId: orgs.id,
      orgLogin: orgs.githubLogin,
      orgType: orgs.type,
      installationId: orgs.installationId,
      email: orgInvites.email,
      githubUserId: orgInvites.githubUserId,
      githubLogin: orgInvites.githubLogin,
      inviterLogin: users.login,
      expiresAt: orgInvites.expiresAt,
      acceptedAt: orgInvites.acceptedAt,
      revokedAt: orgInvites.revokedAt,
    })
    .from(orgInvites)
    .innerJoin(orgs, eq(orgs.id, orgInvites.orgId))
    .leftJoin(users, eq(users.id, orgInvites.invitedBy))
    .where(eq(orgInvites.tokenHash, tokenHash));
  if (!row) return undefined;
  const { installationId, acceptedAt, revokedAt, ...rest } = row;
  return { ...rest, installed: installationId !== null, pending: !acceptedAt && !revokedAt };
}

/** Whether the user already joined the org by invite. */
export async function isMember(database: Db, userId: string, orgId: string): Promise<boolean> {
  const [row] = await database.select({ orgId: orgMembers.orgId }).from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
  return !!row;
}

// ---- Inviting ----------------------------------------------------------------

export type InviteResult = { ok: true; id: string; orgLogin: string } | { ok: false; reason: "not_admin" | "already_member" | "limited" | "self" };

/**
 * An admin invites someone, replacing any pending invite to the same person
 * in the org (so an expired one can be sent again). Serialised per org, so
 * the limits hold under concurrent sends.
 */
export async function createInvite(
  database: Db,
  input: { userId: string; orgId: string; invitee: Invitee; tokenHash: string; now?: Date },
): Promise<InviteResult> {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`org_invites:${input.orgId}`}, 0))`);
    const [org] = await tx
      .select({ login: orgs.githubLogin })
      .from(orgs)
      .where(and(eq(orgs.id, input.orgId), sql`${orgs.installationId} is not null`, isAdmin(input.userId, orgs.id)));
    if (!org) return { ok: false, reason: "not_admin" } as const;

    const same = "email" in input.invitee ? sql`i.email = ${input.invitee.email}` : sql`i.github_user_id = ${input.invitee.githubUserId}`;
    const alreadyIn =
      "email" in input.invitee
        ? sql`exists (select 1 from ${orgMembers} m join ${users} u on u.id = m.user_id where m.org_id = ${input.orgId} and lower(u.email) = ${input.invitee.email})`
        : sql`exists (select 1 from ${orgMembers} m join ${users} u on u.id = m.user_id where m.org_id = ${input.orgId} and u.github_user_id = ${input.invitee.githubUserId})`;
    const self =
      "email" in input.invitee
        ? sql`exists (select 1 from ${users} u where u.id = ${input.userId} and lower(u.email) = ${input.invitee.email})`
        : sql`exists (select 1 from ${users} u where u.id = ${input.userId} and u.github_user_id = ${input.invitee.githubUserId})`;
    const toAddress = "email" in input.invitee ? sql`(select count(*) from ${orgInvites} i where i.email = ${input.invitee.email} and i.created_at > ${at}::timestamptz - interval '1 day')::int` : sql`0`;
    const [counts] = await tx.execute<{ self: boolean; member: boolean; sent_today: number; to_invitee: number; to_address: number; pending: number }>(sql`
      select ${self} as self, ${alreadyIn} as member, ${toAddress} as to_address,
        (select count(*) from ${orgInvites} i where i.invited_by = ${input.userId} and i.created_at > ${at}::timestamptz - interval '1 day')::int as sent_today,
        (select count(*) from ${orgInvites} i where i.org_id = ${input.orgId} and ${same} and i.created_at > ${at}::timestamptz - interval '1 hour')::int as to_invitee,
        (select count(*) from ${orgInvites} i where i.org_id = ${input.orgId} and i.accepted_at is null and i.revoked_at is null and i.expires_at > ${at}::timestamptz)::int as pending
    `);
    if (counts!.self) return { ok: false, reason: "self" } as const;
    if (counts!.member) return { ok: false, reason: "already_member" } as const;
    if (
      counts!.sent_today >= INVITES_PER_DAY ||
      counts!.to_invitee >= INVITES_PER_INVITEE_HOUR ||
      counts!.to_address >= INVITES_PER_ADDRESS_DAY ||
      counts!.pending >= PENDING_INVITES_PER_ORG
    ) {
      return { ok: false, reason: "limited" } as const;
    }

    await tx.execute(sql`update ${orgInvites} i set revoked_at = ${at}::timestamptz where i.org_id = ${input.orgId} and ${same} and i.accepted_at is null and i.revoked_at is null`);
    const [row] = await tx
      .insert(orgInvites)
      .values({
        orgId: input.orgId,
        tokenHash: input.tokenHash,
        ...("email" in input.invitee ? { email: input.invitee.email } : { githubUserId: input.invitee.githubUserId, githubLogin: input.invitee.githubLogin }),
        invitedBy: input.userId,
        expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000),
        createdAt: now,
      })
      .returning({ id: orgInvites.id });
    return { ok: true, id: row!.id, orgLogin: org.login } as const;
  });
}

/** Who a pending invite is for, if the user administers its org: to send it again. */
export async function pendingInvitee(database: Db, userId: string, inviteId: string): Promise<{ orgId: string; invitee: Invitee } | undefined> {
  const [row] = await database
    .select({ orgId: orgInvites.orgId, email: orgInvites.email, githubUserId: orgInvites.githubUserId, githubLogin: orgInvites.githubLogin })
    .from(orgInvites)
    .where(and(eq(orgInvites.id, inviteId), isNull(orgInvites.acceptedAt), isNull(orgInvites.revokedAt), isAdmin(userId, orgInvites.orgId)));
  if (!row) return undefined;
  const invitee: Invitee = row.email !== null ? { email: row.email } : { githubUserId: row.githubUserId!, githubLogin: row.githubLogin ?? "" };
  return { orgId: row.orgId, invitee };
}

/** Revokes a pending invite if the user administers its org. The org's id, or undefined. */
export async function revokeInvite(database: Db, userId: string, inviteId: string, now = new Date()): Promise<string | undefined> {
  const [row] = await database
    .update(orgInvites)
    .set({ revokedAt: now })
    .where(and(eq(orgInvites.id, inviteId), isNull(orgInvites.acceptedAt), isNull(orgInvites.revokedAt), isAdmin(userId, orgInvites.orgId)))
    .returning({ orgId: orgInvites.orgId });
  return row?.orgId;
}

// ---- Joining and leaving -----------------------------------------------------

export type AcceptResult =
  | { ok: true; orgId: string; orgLogin: string }
  | { ok: false; reason: "not_found" | "expired" | "no_installation" | "wrong_person" | "inviter_gone"; orgId?: string };

/**
 * Accepts an invite for `userId`, who GitHub just said is `identity`. The
 * invite is locked and checked again here (still pending, unexpired, the
 * same token, for this person), so a revoke or a resend racing the accept
 * wins or loses cleanly, and one link can't be used twice. Whoever sent it
 * must still be the org's admin: an admin who loses the role can't leave
 * invites behind them.
 */
export async function acceptInvite(
  database: Db,
  input: { userId: string; tokenHash: string; identity: { githubUserId: number; verifiedEmails: string[] }; now?: Date },
): Promise<AcceptResult> {
  const now = input.now ?? new Date();
  return database.transaction(async (tx) => {
    await lockUser(tx, input.userId);
    const [invite] = await tx
      .select({ id: orgInvites.id, orgId: orgInvites.orgId, email: orgInvites.email, githubUserId: orgInvites.githubUserId, expiresAt: orgInvites.expiresAt, invitedBy: orgInvites.invitedBy, orgLogin: orgs.githubLogin, installationId: orgs.installationId })
      .from(orgInvites)
      .innerJoin(orgs, eq(orgs.id, orgInvites.orgId))
      .where(and(eq(orgInvites.tokenHash, input.tokenHash), isNull(orgInvites.acceptedAt), isNull(orgInvites.revokedAt)))
      .for("update", { of: orgInvites });
    if (!invite) return { ok: false, reason: "not_found" } as const;
    if (invite.expiresAt <= now) return { ok: false, reason: "expired", orgId: invite.orgId } as const;
    if (invite.installationId === null) return { ok: false, reason: "no_installation", orgId: invite.orgId } as const;
    const [inviter] = invite.invitedBy
      ? await tx.select({ userId: orgAdmins.userId }).from(orgAdmins).where(and(eq(orgAdmins.userId, invite.invitedBy), eq(orgAdmins.orgId, invite.orgId)))
      : [];
    if (!inviter) return { ok: false, reason: "inviter_gone", orgId: invite.orgId } as const;
    const emails = new Set(input.identity.verifiedEmails.map((email) => email.trim().toLowerCase()));
    const matches = invite.email !== null ? emails.has(invite.email) : invite.githubUserId === input.identity.githubUserId;
    if (!matches) return { ok: false, reason: "wrong_person", orgId: invite.orgId } as const;

    await tx.insert(orgMembers).values({ orgId: invite.orgId, userId: input.userId, invitedBy: invite.invitedBy, createdAt: now }).onConflictDoNothing();
    await tx.update(orgInvites).set({ acceptedAt: now, acceptedBy: input.userId }).where(eq(orgInvites.id, invite.id));
    await grantOrg(tx, input.userId, invite.orgId, now);
    return { ok: true, orgId: invite.orgId, orgLogin: invite.orgLogin } as const;
  });
}

/** Ends a membership and the access it gave; access GitHub gives stays. */
async function endMembership(tx: Tx, orgId: string, memberId: string): Promise<boolean> {
  await lockUser(tx, memberId);
  const removed = await tx
    .delete(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, memberId)))
    .returning({ userId: orgMembers.userId });
  if (removed.length === 0) return false;
  await tx.execute(sql`
    delete from ${permissionCache} pc using ${repos} r
    where pc.user_id = ${memberId} and pc.via = 'invite' and r.id = pc.repo_id and r.org_id = ${orgId}
  `);
  return true;
}

/** An admin removes someone who joined by invite. False if the user isn't an admin or they aren't a member. */
export async function removeMember(database: Db, adminId: string, orgId: string, memberId: string): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [admin] = await tx.select({ orgId: orgAdmins.orgId }).from(orgAdmins).where(and(eq(orgAdmins.userId, adminId), eq(orgAdmins.orgId, orgId)));
    if (!admin) return false;
    return endMembership(tx, orgId, memberId);
  });
}

/** A member leaves an org they joined by invite. */
export async function leaveOrg(database: Db, userId: string, orgId: string): Promise<boolean> {
  return database.transaction((tx) => endMembership(tx, orgId, userId));
}
