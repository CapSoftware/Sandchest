/**
 * Who may open the operator dashboards (/admin): people whose GitHub user id
 * is listed in SANDCHEST_ADMIN_GITHUB_IDS. Ids, not logins, because a login
 * can be renamed and then claimed by someone else. Light enough for the proxy:
 * no better-auth, no GitHub client.
 */
import { sessionUser } from "@sandchest/db";
import { config } from "./config";
import { db } from "./db";
import { sessionCookieName, verifiedSessionToken } from "./session-token";

/** The operators' GitHub user ids. Empty when unset. */
export function adminGithubIds(list: string | undefined): Set<number> {
  if (!list) return new Set();
  return new Set(
    list
      .split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
}

/** Whether this person is an operator. */
export function isAdmin(user: { githubUserId: number | null } | undefined, ids: Set<number> = adminGithubIds(config().SANDCHEST_ADMIN_GITHUB_IDS)): boolean {
  return !!user && user.githubUserId !== null && ids.has(user.githubUserId);
}

/**
 * Whether a request's session cookie belongs to an operator: the signature
 * is checked first, and the database is read only when there are operators
 * and the cookie is genuine.
 */
export async function isOperatorSession(cookies: { get(name: string): { value: string } | undefined }): Promise<boolean> {
  const settings = config();
  const ids = adminGithubIds(settings.SANDCHEST_ADMIN_GITHUB_IDS);
  if (ids.size === 0) return false;
  const token = verifiedSessionToken(cookies.get(sessionCookieName())?.value, settings.BETTER_AUTH_SECRET);
  return token ? isAdmin(await sessionUser(db(), token), ids) : false;
}
