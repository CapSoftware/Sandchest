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
  suspended_at?: string | null;
}

/** An installation as the user's token lists it, for `only` to pick from. */
export type ListedInstallation = Pick<ApiInstallation, "id" | "account">;

interface ApiRepo {
  id: number;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
}

/**
 * Reads a user's access across the app's installations. `only` picks the
 * installations worth reading (those Sandchest knows about). Requests run in parallel.
 */
export async function readUserAccess(token: string, options: { only?: (installations: ListedInstallation[]) => Promise<Set<number>>; http?: HttpOptions } = {}): Promise<{ userId: number; login: string; installations: UserInstallationAccess[] }> {
  const auth = async () => token;
  const http = options.http ?? {};
  const [user, installations] = await Promise.all([
    githubRequest<{ id: number; login: string }>(auth, "/user", {}, http),
    githubPaginate(auth, "/user/installations", (page: { installations: ApiInstallation[] }) => page.installations, {}, http),
  ]);
  // Suspended installations are treated as removed, as their webhook does.
  const people = installations.filter((installation) => installation.account.type !== "Bot" && !installation.suspended_at);
  const keep = options.only ? await options.only(people.map(({ id, account }) => ({ id, account }))) : undefined;
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

/**
 * Who a user token belongs to and, when asked, the email addresses they have
 * verified on GitHub (the App's "Email addresses" permission). Used to check
 * an invite is accepted by the person it was sent to.
 */
export async function readIdentity(token: string, options: { emails: boolean; http?: HttpOptions }): Promise<{ id: number; login: string; verifiedEmails: string[] }> {
  const auth = async () => token;
  const http = options.http ?? {};
  const [user, emails] = await Promise.all([
    githubRequest<{ id: number; login: string }>(auth, "/user", {}, http),
    options.emails ? githubPaginate(auth, "/user/emails", (page: Array<{ email: string; verified: boolean }>) => page, { limit: 100 }, http) : Promise.resolve([]),
  ]);
  return { id: user.id, login: user.login, verifiedEmails: emails.filter((email) => email.verified).map((email) => email.email.toLowerCase()) };
}

/** A GitHub person by login, or undefined if there's no such person (organizations and bots aren't people). */
export async function findGithubUser(token: string, login: string, http: HttpOptions = {}): Promise<{ id: number; login: string } | undefined> {
  try {
    const user = await githubRequest<{ id: number; login: string; type: string }>(async () => token, `/users/${encodeURIComponent(login)}`, {}, http);
    return user.type === "User" ? { id: user.id, login: user.login } : undefined;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return undefined;
    throw error;
  }
}
