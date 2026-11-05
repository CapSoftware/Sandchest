/**
 * Who may see what (SPEC §3). A person sees a repository's findings only if
 * GitHub reports push access or higher, and changes an org's settings only
 * as its admin. Access is read from GitHub with the person's own token and
 * cached for five minutes: after two it refreshes in the background, after
 * five a request waits for GitHub.
 */
import { githubAccountRowId, orgsByInstallation, replaceAccess, repoIdsByGithubId, sessionUser, userById, type RepoPermission } from "@sandchest/db";
import { GitHubError, readUserAccess, type HttpOptions } from "@sandchest/github";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { cache } from "react";
import { auth, authConfigured, sessionCookieName, verifiedSessionToken } from "./auth";
import { config } from "./config";
import { db } from "./db";

const SOFT_TTL_MS = 2 * 60_000;
const HARD_TTL_MS = 5 * 60_000;
const VISIBLE: ReadonlySet<string> = new Set<RepoPermission>(["admin", "maintain", "write"]);

export interface Viewer {
  id: string;
  name: string;
  login: string | null;
  /** The GitHub account id: stable, unlike the login. */
  githubUserId: number | null;
  image: string | null;
  /** When access was last read from GitHub. */
  accessCheckedAt: Date | null;
  /** When this session expires; the dashboard extends it once a day while it is used. */
  sessionExpiresAt: Date;
}

/**
 * The signed-in person, once per request, in one database round trip: the
 * cookie's signature is checked here and the session is read with its user.
 * (better-auth's own `getSession` takes three queries in a row.)
 */
export const currentUser = cache(async (): Promise<Viewer | undefined> => {
  // Cookies first: reading them marks the page as per-request before anything else runs.
  const jar = await cookies();
  if (!authConfigured()) return undefined;
  const token = verifiedSessionToken(jar.get(sessionCookieName())?.value, config().BETTER_AUTH_SECRET);
  return token ? sessionUser(db(), token) : undefined;
});

/** The signed-in person with fresh access, or a redirect to sign in. */
export const viewer = cache(async (): Promise<Viewer> => {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  try {
    await ensureAccess(user.id, { checkedAt: user.accessCheckedAt });
  } catch (error) {
    // The GitHub grant was revoked or expired beyond refresh: start again.
    if (error instanceof GitHubError && error.status === 401) {
      await auth().api.signOut({ headers: await headers() }).catch(() => {});
      redirect("/sign-in?expired=1");
    }
    throw error;
  }
  return user;
});

const inFlight = new Map<string, Promise<void>>();

/**
 * Makes sure the user's cached access is recent enough to trust. Pass
 * `checkedAt` when it is already known (it comes with the session) to skip
 * looking it up.
 */
export async function ensureAccess(userId: string, options: { force?: boolean; checkedAt?: Date | null } = {}): Promise<void> {
  const checkedAt = options.checkedAt !== undefined ? options.checkedAt : ((await userById(db(), userId))?.accessCheckedAt ?? null);
  const age = checkedAt ? Date.now() - checkedAt.getTime() : Number.POSITIVE_INFINITY;
  if (!options.force && age < SOFT_TTL_MS) return;
  if (!options.force && age < HARD_TTL_MS) {
    after(() => refreshAccess(userId).catch(() => {}));
    return;
  }
  await refreshAccess(userId);
}

/** Access read this recently is not read again on the way back from GitHub: nobody installs the App that fast. */
const INSTALL_REREAD_MS = 10_000;

/**
 * Whether to read access again now, on the way back from installing the
 * GitHub App (`installation_id` in the URL), so new repositories show at
 * once. Anyone can add it to the URL and reload, so only a real id counts,
 * and not when access was read moments ago.
 */
export function readAgainOnInstall(installationId: string | undefined, checkedAt: Date | null, now = Date.now()): boolean {
  if (!installationId || !/^[1-9]\d*$/.test(installationId) || !Number.isSafeInteger(Number(installationId))) return false;
  return !checkedAt || now - checkedAt.getTime() >= INSTALL_REREAD_MS;
}

/** Reads the user's access from GitHub and replaces the cache. Concurrent calls share one read. */
export function refreshAccess(userId: string, http?: HttpOptions): Promise<void> {
  let pending = inFlight.get(userId);
  if (!pending) {
    pending = (async () => storeAccess(userId, await githubToken(userId), http))().finally(() => inFlight.delete(userId));
    inFlight.set(userId, pending);
  }
  return pending;
}

/** The user's GitHub token, refreshed if it expired. A GitHubError 401 when there's none: they sign in again. */
export async function githubToken(userId: string): Promise<string> {
  const accountId = await githubAccountRowId(db(), userId);
  if (!accountId) throw new GitHubError("No GitHub account for this user", 401, false);
  // A refresh token that expired or was revoked means signing in again, like a 401 from GitHub.
  const { accessToken } = await auth()
    .api.getAccessToken({ body: { accountId, userId } })
    .catch(() => ({ accessToken: undefined }));
  if (!accessToken) throw new GitHubError("No usable GitHub token for this user", 401, false);
  return accessToken;
}

/** The part of a refresh after the token: GitHub → database. Exposed for tests. */
export async function storeAccess(userId: string, token: string, http?: HttpOptions): Promise<void> {
  // Only installations Sandchest has recorded matter; unknown ones cost no further requests.
  const known = new Map<number, string>();
  const access = await readUserAccess(token, {
    http,
    only: async (installations) => {
      for (const org of await orgsByInstallation(db(), installations.map((i) => i.id))) if (org.installationId) known.set(org.installationId, org.id);
      // Back from installing before GitHub's webhook arrived: record the installation now, as the webhook will.
      const unknown = installations.filter((i) => !known.has(i.id));
      if (unknown.length > 0) {
        const { recordListedInstallations } = await import("./installations");
        for (const org of await recordListedInstallations(unknown)) known.set(org.installationId, org.id);
      }
      return new Set(known.keys());
    },
  });

  const installations = access.installations.filter((i) => known.has(i.installationId));
  const visible = installations.flatMap((i) => i.repos.filter((repo) => VISIBLE.has(repo.role)));
  const repoIds = await repoIdsByGithubId(db(), visible.map((repo) => repo.id));
  await replaceAccess(db(), userId, {
    repos: visible.flatMap((repo) => (repoIds.has(repo.id) ? [{ repoId: repoIds.get(repo.id)!, permission: repo.role as RepoPermission }] : [])),
    adminOrgIds: installations.filter((i) => i.admin).map((i) => known.get(i.installationId)!),
    github: { id: access.userId, login: access.login },
  });
}
