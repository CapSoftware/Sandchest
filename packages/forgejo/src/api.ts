/**
 * The Forgejo (and Gitea) API calls Sandchest makes, as the bot account.
 * Requests go through the GitHub client: the same retries, timeouts and
 * `Link` pagination, which Forgejo sends too.
 */
import { githubPaginate, githubRequest, githubText, GitHubError, type CheckConclusion, type HttpOptions, type InstalledRepository, type PullFile, type ReviewComment } from "@sandchest/github";
import type { ForgejoConfig } from "./config";
import { splitDiff } from "./diff";

/** An owner the bot covers. */
export interface Owner {
  id: number;
  login: string;
  type: "User" | "Organization";
}

/** A commit status's state. Forgejo has no Checks: one status per commit and context stands in for a Check run. */
export type StatusState = "pending" | "success" | "error" | "failure" | "warning";

/**
 * A Check's conclusion as a commit status. Neutral (not reviewed, or the
 * review could not finish) is a success, so it never blocks a merge, as on GitHub.
 */
export function statusState(conclusion: CheckConclusion): StatusState {
  if (conclusion === "success" || conclusion === "neutral") return "success";
  if (conclusion === "cancelled") return "error";
  return "failure";
}

/** Forgejo keeps a status's description short; the rest goes in the PR comment and behind the link. */
const DESCRIPTION_MAX = 255;

/** Page size: Forgejo's default maximum. */
const LIMIT = 50;

interface ApiRepository {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  archived?: boolean;
  mirror?: boolean;
  /** No commits yet: nothing to clone. */
  empty?: boolean;
  description?: string | null;
  language?: string | null;
  updated_at?: string | null;
}

interface ApiHook {
  id: number;
  type: string;
  active: boolean;
  config: { url?: string };
}

/** The events Sandchest's webhook subscribes to. `pull_request` covers synchronisation and comments on pull requests. */
export const WEBHOOK_EVENTS = ["push", "pull_request", "issue_comment", "repository"] as const;

export class Forgejo {
  private readonly auth: () => Promise<string>;
  private readonly http: HttpOptions;

  constructor(
    readonly config: ForgejoConfig,
    http: HttpOptions = {},
  ) {
    this.auth = async () => config.token;
    this.http = { ...http, baseUrl: config.apiUrl, name: "Forgejo" };
  }

  /** An organisation, or else a user, by name. */
  async owner(name: string): Promise<Owner> {
    try {
      const org = await this.get<{ id: number; username?: string; name: string }>(`/orgs/${encodeURIComponent(name)}`);
      return { id: org.id, login: org.username || org.name, type: "Organization" };
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 404)) throw error;
    }
    const user = await this.get<{ id: number; login: string }>(`/users/${encodeURIComponent(name)}`);
    return { id: user.id, login: user.login, type: "User" };
  }

  /** The owner's repositories the bot can read, except archived ones and mirrors (nobody pushes to them here) and empty ones. */
  async repositories(owner: Owner): Promise<InstalledRepository[]> {
    const path = `/${owner.type === "Organization" ? "orgs" : "users"}/${encodeURIComponent(owner.login)}/repos?limit=${LIMIT}`;
    const repos = await githubPaginate(this.auth, path, (page: ApiRepository[]) => page, {}, this.http);
    return repos.filter((repo) => !repo.archived && !repo.mirror && !repo.empty).map(toInstalled);
  }

  async repository(fullName: string): Promise<InstalledRepository & { empty: boolean }> {
    const repo = await this.get<ApiRepository>(`/repos/${fullName}`);
    return { ...toInstalled(repo), empty: !!repo.empty };
  }

  pull(repo: string, number: number): Promise<{ number: number; draft?: boolean; head: { sha: string; repo_id: number }; base: { sha: string; ref: string }; user: { login: string } }> {
    return this.get(`/repos/${repo}/pulls/${number}`);
  }

  /** Changed files with their patches, read from the pull request's diff. */
  async pullFiles(repo: string, number: number, signal?: AbortSignal): Promise<PullFile[]> {
    return splitDiff(await githubText(this.auth, `/repos/${repo}/pulls/${number}.diff`, { signal, headers: { accept: "text/plain" } }, this.http));
  }

  /** Files changed between two commits (names and statuses only). */
  async compare(repo: string, base: string, head: string): Promise<PullFile[]> {
    type File = { filename: string; status: string };
    const result = await this.get<{ files?: File[]; commits?: Array<{ files?: File[] }> }>(`/repos/${repo}/compare/${base}...${head}`);
    // Newer Forgejo lists the files of the whole range; older versions only each commit's.
    const files = result.files ?? (result.commits ?? []).flatMap((commit) => commit.files ?? []);
    const unique = new Map(files.map((file) => [file.filename, file]));
    return [...unique.values()].map((file) => ({ filename: file.filename, status: fileStatus(file.status), additions: 0, deletions: 0 }));
  }

  async branchSha(repo: string, branch: string): Promise<string> {
    const result = await this.get<{ commit: { id: string } }>(`/repos/${repo}/branches/${encodeURIComponent(branch)}`);
    return result.commit.id;
  }

  /** Sets the commit's status for `context`. A later status with the same context replaces it. Returns its id. */
  async setStatus(repo: string, sha: string, input: { state: StatusState; context: string; description: string; targetUrl?: string }): Promise<number> {
    const description = input.description.length > DESCRIPTION_MAX ? `${input.description.slice(0, DESCRIPTION_MAX - 1)}…` : input.description;
    const result = await githubRequest<{ id: number }>(
      this.auth,
      `/repos/${repo}/statuses/${encodeURIComponent(sha)}`,
      { method: "POST", body: { state: input.state, context: input.context, description, target_url: input.targetUrl } },
      this.http,
    );
    return result.id;
  }

  /** One review holding every inline comment, so the PR gets one notification. Lines are new-file line numbers. */
  async createReview(repo: string, number: number, input: { commitId: string; body: string; comments: ReviewComment[] }): Promise<void> {
    await githubRequest(
      this.auth,
      `/repos/${repo}/pulls/${number}/reviews`,
      {
        method: "POST",
        body: { commit_id: input.commitId, event: "COMMENT", body: input.body, comments: input.comments.map((c) => ({ path: c.path, body: c.body, new_position: c.line, old_position: 0 })) },
      },
      this.http,
    );
  }

  async comment(repo: string, issueNumber: number, body: string): Promise<void> {
    await githubRequest(this.auth, `/repos/${repo}/issues/${issueNumber}/comments`, { method: "POST", body: { body } }, this.http);
  }

  /** The user's permission on the repo, in GitHub's words: admin, write, read or none. */
  async permission(repo: string, username: string): Promise<string> {
    try {
      const result = await this.get<{ permission: string }>(`/repos/${repo}/collaborators/${encodeURIComponent(username)}/permission`);
      return result.permission === "owner" ? "admin" : result.permission;
    } catch (error) {
      // Forgejo answers 403 or 404 for someone who is not a collaborator.
      if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) return "none";
      throw error;
    }
  }

  /**
   * Makes sure the organisation (or the repository) sends Sandchest its
   * events: adds the webhook unless one already points at `url`. Returns
   * whether it had to be added.
   */
  async ensureWebhook(target: { org: string } | { repo: string }, url: string): Promise<boolean> {
    const base = "org" in target ? `/orgs/${encodeURIComponent(target.org)}/hooks` : `/repos/${target.repo}/hooks`;
    const hooks = await githubPaginate(this.auth, `${base}?limit=${LIMIT}`, (page: ApiHook[]) => page, {}, this.http);
    if (hooks.some((hook) => hook.config.url === url)) return false;
    await githubRequest(
      this.auth,
      base,
      // "gitea" is the type both Forgejo and Gitea accept; Forgejo still signs with both header sets.
      { method: "POST", body: { type: "gitea", active: true, events: WEBHOOK_EVENTS, config: { url, content_type: "json", secret: this.config.webhookSecret } } },
      this.http,
    );
    return true;
  }

  private get<T>(path: string): Promise<T> {
    return githubRequest<T>(this.auth, path, {}, this.http);
  }
}

function toInstalled(repo: ApiRepository): InstalledRepository {
  return { id: repo.id, full_name: repo.full_name, private: repo.private, default_branch: repo.default_branch, description: repo.description, language: repo.language || null, pushed_at: repo.updated_at };
}

function fileStatus(status: string): PullFile["status"] {
  return (["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"] as const).find((s) => s === status) ?? (status === "deleted" ? "removed" : "modified");
}
