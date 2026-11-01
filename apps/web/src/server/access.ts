/**
 * Who may see what (SPEC §3). A person sees a repository's findings only if
 * GitHub reports push access or higher, and changes an org's settings only
 * as its admin. Access is read from GitHub with the person's own token and
 * cached for five minutes: after two it refreshes in the background, after
 * five a request waits for GitHub.
 */
import { githubAccountRowId, orgsByInstallation, replaceAccess, repoIdsByGithubId, userById, type RepoPermission } from "@sandchest/db";
import { GitHubError, readUserAccess, type HttpOptions } from "@sandchest/github";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { cache } from "react";
import { auth } from "./auth";
import { db } from "./services";

const SOFT_TTL_MS = 2 * 60_000;
const HARD_TTL_MS = 5 * 60_000;
const VISIBLE: ReadonlySet<string> = new Set<RepoPermission>(["admin", "maintain", "write"]);

export interface Viewer {
  id: string;
  name: string;
  login: string | null;
  image: string | null;
}

/** The signed-in person, once per request. */
export const currentUser = cache(async (): Promise<Viewer | undefined> => {
  // Headers first: it marks the page as per-request before anything else runs.
  const requestHeaders = await headers();
  const session = await auth().api.getSession({ headers: requestHeaders });
  if (!session) return undefined;
  const user = session.user as typeof session.user & { login?: string | null };
  return { id: user.id, name: user.name, login: user.login ?? null, image: user.image ?? null };
});

/** The signed-in person with fresh access, or a redirect to sign in. */
export const viewer = cache(async (): Promise<Viewer> => {
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  try {
    await ensureAccess(user.id);
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

/** Makes sure the user's cached access is recent enough to trust. */
export async function ensureAccess(userId: string, options: { force?: boolean } = {}): Promise<void> {
  const user = await userById(db(), userId);
  const age = user?.accessCheckedAt ? Date.now() - user.accessCheckedAt.getTime() : Number.POSITIVE_INFINITY;
  if (!options.force && age < SOFT_TTL_MS) return;
  if (!options.force && age < HARD_TTL_MS) {
    after(() => refreshAccess(userId).catch(() => {}));
    return;
  }
  await refreshAccess(userId);
}

/** Reads the user's access from GitHub and replaces the cache. Concurrent calls share one read. */
export function refreshAccess(userId: string, http?: HttpOptions): Promise<void> {
  let pending = inFlight.get(userId);
  if (!pending) {
    pending = (async () => {
      const accountId = await githubAccountRowId(db(), userId);
      if (!accountId) throw new GitHubError("No GitHub account for this user", 401, false);
      // A refresh token that expired or was revoked means signing in again, like a 401 from GitHub.
      const { accessToken } = await auth()
        .api.getAccessToken({ body: { accountId, userId } })
        .catch(() => ({ accessToken: undefined }));
      if (!accessToken) throw new GitHubError("No usable GitHub token for this user", 401, false);
      await storeAccess(userId, accessToken, http);
    })().finally(() => inFlight.delete(userId));
    inFlight.set(userId, pending);
  }
  return pending;
}

/** The part of a refresh after the token: GitHub → database. Exposed for tests. */
export async function storeAccess(userId: string, token: string, http?: HttpOptions): Promise<void> {
  // Only installations Sandchest has recorded matter; unknown ones cost no further requests.
  const known = new Map<number, string>();
  const access = await readUserAccess(token, {
    http,
    only: async (installationIds) => {
      for (const org of await orgsByInstallation(db(), installationIds)) if (org.installationId) known.set(org.installationId, org.id);
      return new Set(known.keys());
    },
  });

  const installations = access.installations.filter((i) => known.has(i.installationId));
  const visible = installations.flatMap((i) => i.repos.filter((repo) => VISIBLE.has(repo.role)));
  const repoIds = await repoIdsByGithubId(db(), visible.map((repo) => repo.id));
  await replaceAccess(db(), userId, {
    repos: visible.flatMap((repo) => (repoIds.has(repo.id) ? [{ repoId: repoIds.get(repo.id)!, permission: repo.role as RepoPermission }] : [])),
    adminOrgIds: installations.filter((i) => i.admin).map((i) => known.get(i.installationId)!),
  });
}
