/**
 * What a signed-in person can reach, read with their own GitHub token (a
 * GitHub App user token): the app's installations they can see, their
 * permission on each repository there, and whether they administer the
 * installation's account.
 */
import { GitHubError, githubPaginate, githubRequest, type HttpOptions } from "./client";

export type RepoRole = "admin" | "maintain" | "write" | "triage" | "read";

export interface UserInstallationAccess {
  installationId: number;
  account: { id: number; login: string; type: "User" | "Organization" | "Bot" };
  /** Every repository in the installation the user can see, with their role. */
  repos: Array<{ id: number; role: RepoRole }>;
  /** GitHub org admin, or the owner of a personal account. */
  admin: boolean;
}

interface ApiInstallation {
  id: number;
  account: { id: number; login: string; type: "User" | "Organization" | "Bot" };
}

interface ApiRepo {
  id: number;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
}

/**
 * Reads a user's access across the app's installations. `only` picks the
 * installations worth reading (those Sandchest knows about). Requests run in parallel.
 */
export async function readUserAccess(token: string, options: { only?: (installationIds: number[]) => Promise<Set<number>>; http?: HttpOptions } = {}): Promise<{ userId: number; login: string; installations: UserInstallationAccess[] }> {
  const auth = async () => token;
  const http = options.http ?? {};
  const [user, installations] = await Promise.all([
    githubRequest<{ id: number; login: string }>(auth, "/user", {}, http),
    githubPaginate(auth, "/user/installations", (page: { installations: ApiInstallation[] }) => page.installations, {}, http),
  ]);
  const people = installations.filter((installation) => installation.account.type !== "Bot");
  const keep = options.only ? await options.only(people.map((installation) => installation.id)) : undefined;
  const wanted = keep ? people.filter((installation) => keep.has(installation.id)) : people;
  const results = await Promise.all(
    wanted.map(async (installation): Promise<UserInstallationAccess> => {
      const [repos, admin] = await Promise.all([
        githubPaginate(auth, `/user/installations/${installation.id}/repositories`, (page: { repositories: ApiRepo[] }) => page.repositories, {}, http),
        installation.account.type === "User" ? Promise.resolve(installation.account.id === user.id) : isOrgAdmin(auth, installation.account.login, http),
      ]);
      return { installationId: installation.id, account: installation.account, repos: repos.map((repo) => ({ id: repo.id, role: roleOf(repo) })), admin };
    }),
  );
  return { userId: user.id, login: user.login, installations: results };
}

async function isOrgAdmin(auth: () => Promise<string>, org: string, http: HttpOptions): Promise<boolean> {
  try {
    const membership = await githubRequest<{ state: string; role: string }>(auth, `/user/memberships/orgs/${encodeURIComponent(org)}`, {}, http);
    return membership.state === "active" && membership.role === "admin";
  } catch (error) {
    // Not a member, or the membership is private to the app: not an admin.
    if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) return false;
    throw error;
  }
}

function roleOf(repo: ApiRepo): RepoRole {
  const p = repo.permissions ?? {};
  return p.admin ? "admin" : p.maintain ? "maintain" : p.push ? "write" : p.triage ? "triage" : "read";
}
