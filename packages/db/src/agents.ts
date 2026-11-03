/**
 * Agents' credentials: API keys, OAuth clients, codes and tokens, and device
 * grants. Every secret is stored as its SHA-256 hash; the web app makes and
 * hashes them (see apps/web/src/server/agent/tokens.ts).
 */
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import { apiTokens, deviceGrants, oauthClients, oauthCodes, scans, users } from "./schema";

export type ApiTokenKind = (typeof apiTokens.$inferSelect)["kind"];

/** Who a bearer token acts as, with what the API needs on every request. One query. */
export interface TokenPrincipal {
  tokenId: string;
  kind: ApiTokenKind;
  lastUsedAt: Date | null;
  user: { id: string; name: string; login: string | null; githubUserId: number | null; image: string | null; accessCheckedAt: Date | null };
}

export async function tokenPrincipal(database: Db, tokenHash: string): Promise<TokenPrincipal | undefined> {
  const [row] = await database
    .select({
      tokenId: apiTokens.id,
      kind: apiTokens.kind,
      lastUsedAt: apiTokens.lastUsedAt,
      user: { id: users.id, name: users.name, login: users.login, githubUserId: users.githubUserId, image: users.image, accessCheckedAt: users.accessCheckedAt },
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(apiTokens.tokenHash, tokenHash),
        // Refresh tokens are only ever spent at the token endpoint.
        inArray(apiTokens.kind, ["key", "access"]),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), sql`${apiTokens.expiresAt} > now()`),
      ),
    );
  return row;
}

/** Records that a token was used, at most every five minutes, so busy agents don't write on every request. */
export async function touchToken(database: Db, tokenId: string): Promise<void> {
  await database
    .update(apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiTokens.id, tokenId), or(isNull(apiTokens.lastUsedAt), sql`${apiTokens.lastUsedAt} < now() - interval '5 minutes'`)));
}

export interface NewToken {
  userId: string;
  kind: ApiTokenKind;
  name: string;
  tokenHash: string;
  prefix: string;
  clientId?: string | null;
  family?: string | null;
  expiresAt?: Date | null;
}

export async function createApiToken(database: Db, token: NewToken): Promise<{ id: string; createdAt: Date }> {
  const [row] = await database.insert(apiTokens).values(token).returning({ id: apiTokens.id, createdAt: apiTokens.createdAt });
  return row!;
}

/** What Settings and the API list: API keys, and one row per connected MCP client sign-in. */
export interface AgentAccess {
  id: string;
  kind: "key" | "oauth";
  name: string;
  prefix: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/**
 * A person's live API keys, and the MCP clients they've connected: one row per
 * sign-in (token family), named after the client, last used whenever any of
 * its tokens was. Newest first.
 */
export async function userAgentAccess(database: Db, userId: string): Promise<AgentAccess[]> {
  const rows = await database.execute<{ id: string; kind: "key" | "oauth"; name: string; prefix: string | null; created_at: string; last_used_at: string | null }>(sql`
    select id, 'key' as kind, name, prefix, created_at, last_used_at from ${apiTokens}
    where user_id = ${userId} and kind = 'key' and revoked_at is null
    union all
    select (array_agg(t.id order by t.created_at))[1], 'oauth', coalesce(max(c.name), max(t.name)), null, min(t.created_at), max(t.last_used_at)
    from ${apiTokens} t left join ${oauthClients} c on c.id = t.client_id
    where t.user_id = ${userId} and t.kind in ('access', 'refresh') and t.family is not null and t.revoked_at is null
      and (t.expires_at is null or t.expires_at > now())
    group by t.family
    order by 5 desc
  `);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    prefix: row.prefix,
    createdAt: new Date(row.created_at),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
  }));
}

/**
 * Revokes one of a person's API keys, or every token of the MCP sign-in a
 * token belongs to. False if it isn't theirs or is already revoked.
 */
export async function revokeUserToken(database: Db, userId: string, tokenId: string): Promise<{ kind: "key" | "oauth" } | undefined> {
  const [token] = await database
    .select({ kind: apiTokens.kind, family: apiTokens.family })
    .from(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)));
  if (!token) return undefined;
  if (token.family) {
    await revokeFamily(database, token.family);
    return { kind: "oauth" };
  }
  await database.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));
  return { kind: "key" };
}

/** Revokes a token presented by hash (RFC 7009): its whole family for OAuth tokens. Unknown tokens are ignored. */
export async function revokeTokenByHash(database: Db, tokenHash: string): Promise<void> {
  const [token] = await database.select({ id: apiTokens.id, family: apiTokens.family }).from(apiTokens).where(eq(apiTokens.tokenHash, tokenHash));
  if (!token) return;
  if (token.family) await revokeFamily(database, token.family);
  else await database.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.id, token.id), isNull(apiTokens.revokedAt)));
}

async function revokeFamily(database: Db, family: string): Promise<void> {
  await database
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.family, family), isNull(apiTokens.revokedAt)));
}

// ---- OAuth -----------------------------------------------------------------

export async function registerOAuthClient(database: Db, client: { id: string; name: string; redirectUris: string[] }): Promise<{ createdAt: Date }> {
  const [row] = await database.insert(oauthClients).values(client).returning({ createdAt: oauthClients.createdAt });
  return row!;
}

/**
 * How many rows the anonymous endpoints added in the last `seconds`, counted
 * no further than `upTo`: the overall ceiling on registrations and device
 * codes, the same across every server instance.
 */
export async function recentlyAdded(database: Db, table: "oauth_clients" | "device_grants", seconds: number, upTo: number): Promise<number> {
  const source = table === "oauth_clients" ? oauthClients : deviceGrants;
  const [row] = await database.execute<{ n: number }>(sql`
    select count(*)::int as n from (
      select 1 from ${source} where ${source.createdAt} > now() - ${seconds}::int * interval '1 second' limit ${upTo}
    ) recent
  `);
  return row?.n ?? 0;
}

export async function oauthClient(database: Db, clientId: string) {
  return database.query.oauthClients.findFirst({ where: eq(oauthClients.id, clientId) });
}

export async function saveOAuthCode(database: Db, code: typeof oauthCodes.$inferInsert): Promise<void> {
  await database.insert(oauthCodes).values(code);
}

/** Spends an authorization code: it can be taken once, before it expires. */
export async function takeOAuthCode(database: Db, codeHash: string) {
  const [row] = await database
    .delete(oauthCodes)
    .where(eq(oauthCodes.codeHash, codeHash))
    .returning();
  return row && row.expiresAt.getTime() > Date.now() ? row : undefined;
}

/**
 * Spends a refresh token so a new pair can be issued. A token spent before
 * is a sign it was copied: unless it was spent a moment ago (a client
 * retrying), every token in its family is revoked.
 */
export async function spendRefreshToken(
  database: Db,
  tokenHash: string,
  clientId: string,
): Promise<{ ok: true; userId: string; family: string; name: string } | { ok: false }> {
  return database.transaction(async (tx) => {
    const [token] = await tx
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, tokenHash), eq(apiTokens.kind, "refresh")))
      .for("update");
    if (!token || !token.family || token.clientId !== clientId) return { ok: false };
    if (token.revokedAt) {
      if (Date.now() - token.revokedAt.getTime() > 30_000) {
        await tx
          .update(apiTokens)
          .set({ revokedAt: new Date() })
          .where(and(eq(apiTokens.family, token.family), isNull(apiTokens.revokedAt)));
      }
      return { ok: false };
    }
    if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) return { ok: false };
    // The family's old access tokens go with it: the new pair replaces them.
    await tx
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.family, token.family), isNull(apiTokens.revokedAt)));
    return { ok: true, userId: token.userId, family: token.family, name: token.name };
  });
}

// ---- Device flow -----------------------------------------------------------

export async function createDeviceGrant(database: Db, grant: { deviceCodeHash: string; userCode: string; clientName: string; expiresAt: Date }): Promise<void> {
  await database.insert(deviceGrants).values(grant);
}

/** A device grant still waiting for the person, by the code they were shown. */
export async function pendingDeviceGrant(database: Db, userCode: string) {
  return database.query.deviceGrants.findFirst({
    where: and(eq(deviceGrants.userCode, userCode), eq(deviceGrants.status, "pending"), sql`${deviceGrants.expiresAt} > now()`),
    columns: { id: true, clientName: true, expiresAt: true, createdAt: true },
  });
}

/** Approves or denies a pending device grant for this person. False if it isn't pending any more. */
export async function decideDeviceGrant(database: Db, userCode: string, userId: string, approve: boolean): Promise<boolean> {
  const rows = await database
    .update(deviceGrants)
    .set({ status: approve ? "approved" : "denied", userId })
    .where(and(eq(deviceGrants.userCode, userCode), eq(deviceGrants.status, "pending"), sql`${deviceGrants.expiresAt} > now()`))
    .returning({ id: deviceGrants.id });
  return rows.length === 1;
}

export type DevicePoll =
  | { state: "pending" | "slow_down" | "denied" | "expired" | "invalid" }
  | { state: "issued"; userId: string; clientName: string; tokenId: string };

/**
 * The agent's poll. An approved grant issues `key` (already hashed) exactly
 * once, in the same transaction that marks it issued. Polling sooner than
 * `intervalS` after the last poll is answered `slow_down`.
 */
export async function pollDeviceGrant(database: Db, deviceCodeHash: string, intervalS: number, key: { tokenHash: string; prefix: string }): Promise<DevicePoll> {
  return database.transaction(async (tx) => {
    const [grant] = await tx.select().from(deviceGrants).where(eq(deviceGrants.deviceCodeHash, deviceCodeHash)).for("update");
    if (!grant || grant.status === "issued") return { state: "invalid" };
    if (grant.expiresAt.getTime() <= Date.now()) return { state: "expired" };
    if (grant.status === "denied") return { state: "denied" };
    const tooSoon = grant.polledAt !== null && Date.now() - grant.polledAt.getTime() < (intervalS - 1) * 1_000;
    if (grant.status === "pending") {
      await tx.update(deviceGrants).set({ polledAt: new Date() }).where(eq(deviceGrants.id, grant.id));
      return { state: tooSoon ? "slow_down" : "pending" };
    }
    await tx.update(deviceGrants).set({ status: "issued", polledAt: new Date() }).where(eq(deviceGrants.id, grant.id));
    const [token] = await tx
      .insert(apiTokens)
      .values({ userId: grant.userId!, kind: "key", name: grant.clientName, tokenHash: key.tokenHash, prefix: key.prefix })
      .returning({ id: apiTokens.id });
    return { state: "issued", userId: grant.userId!, clientName: grant.clientName, tokenId: token!.id };
  });
}

/** Clears out what no one can use any more. Run by the sweep. */
export async function deleteExpiredAgentGrants(database: Db): Promise<void> {
  const day = sql`now() - interval '1 day'`;
  await Promise.all([
    database.delete(deviceGrants).where(lt(deviceGrants.expiresAt, day)),
    database.delete(oauthCodes).where(lt(oauthCodes.expiresAt, day)),
    database.delete(apiTokens).where(or(lt(apiTokens.expiresAt, sql`now() - interval '7 days'`), lt(apiTokens.revokedAt, sql`now() - interval '30 days'`))),
  ]);
  // Registration is open, so clients that never got a token (abandoned sign-ins, or noise) go after 30 days.
  // Not sooner: MCP clients keep their registration and may come back to it.
  await database.execute(sql`
    delete from ${oauthClients} c
    where c.created_at < now() - interval '30 days'
      and not exists (select 1 from ${apiTokens} t where t.client_id = c.id)
      and not exists (select 1 from ${oauthCodes} o where o.client_id = c.id)
  `);
}

/** A scan's status alone, for waiting on it. The caller has already checked the person may see it. */
export async function scanStatusOnly(database: Db, scanId: string): Promise<string | undefined> {
  const [row] = await database.select({ status: scans.status }).from(scans).where(eq(scans.id, scanId));
  return row?.status;
}

/** A device grant's state alone, read without locking or writing, for a poll that waits. */
export async function deviceGrantStatus(database: Db, deviceCodeHash: string): Promise<{ status: string; expired: boolean } | undefined> {
  const [row] = await database
    .select({ status: deviceGrants.status, expired: sql<boolean>`${deviceGrants.expiresAt} <= now()` })
    .from(deviceGrants)
    .where(eq(deviceGrants.deviceCodeHash, deviceCodeHash));
  return row;
}
