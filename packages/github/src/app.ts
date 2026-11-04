/**
 * GitHub App authentication and the API calls Sandchest makes. Installation
 * tokens are cached and refreshed before they expire; clone tokens are
 * scoped to a single repository with read-only contents.
 */
import { createSign } from "node:crypto";
import { GitHubError, githubPaginate, githubRequest, type HttpOptions } from "./client";

export interface AppConfig {
  appId: string;
  /** PEM. Escaped newlines (`\n`) from env files are accepted. */
  privateKey: string;
  webhookSecret: string;
}

/** Reads `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`. */
export function loadAppConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const missing = ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"].filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`Missing GitHub App configuration: ${missing.join(", ")}`);
  return { appId: env.GITHUB_APP_ID!, privateKey: env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"), webhookSecret: env.GITHUB_WEBHOOK_SECRET! };
}

/** A JWT signed with the app's private key, valid for nine minutes. */
export function appJwt(config: Pick<AppConfig, "appId" | "privateKey">, now = Date.now()): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issuedAt = Math.floor(now / 1000) - 60; // Allow for clock drift.
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: issuedAt, exp: issuedAt + 540, iss: config.appId })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(config.privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Refresh tokens this long before GitHub expires them. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export class GitHubApp {
  private readonly tokens = new Map<string, Promise<CachedToken>>();

  constructor(
    readonly config: AppConfig,
    private readonly http: HttpOptions = {},
  ) {}

  /** An API handle for one installation. */
  installation(installationId: number): Installation {
    return new Installation(this, installationId, this.http);
  }

  /**
   * An installation token, shared by concurrent callers and refreshed before
   * expiry. `scope` narrows it to repositories and permissions.
   */
  async token(installationId: number, scope?: { repositoryIds: number[]; permissions: Record<string, "read" | "write"> }): Promise<string> {
    const key = `${installationId}:${scope ? JSON.stringify(scope) : "*"}`;
    const cached = this.tokens.get(key);
    if (cached) {
      const token = await cached.catch(() => undefined);
      if (token && token.expiresAt - REFRESH_MARGIN_MS > Date.now()) return token.token;
    }
    const pending = githubRequest<{ token: string; expires_at: string }>(
      async () => appJwt(this.config),
      `/app/installations/${installationId}/access_tokens`,
      { method: "POST", body: scope ? { repository_ids: scope.repositoryIds, permissions: scope.permissions } : {} },
      this.http,
    ).then((response) => ({ token: response.token, expiresAt: Date.parse(response.expires_at) }));
    this.tokens.set(key, pending);
    pending.catch(() => this.tokens.delete(key));
    return (await pending).token;
  }
}

export interface InstalledRepository {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  language?: string | null;
  description?: string | null;
  pushed_at?: string | null;
}

/** The fields of GET /orgs/{org} and /users/{user} that Sandchest reads. Orgs have `description`, users `bio`. */
export interface AccountProfile {
  login: string;
  name: string | null;
  description?: string | null;
  bio?: string | null;
  blog: string | null;
  location: string | null;
  avatar_url: string;
}

export interface PullFile {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  /** Absent for binary files and very large diffs. */
  patch?: string;
  previous_filename?: string;
}

/** An open pull request, as the dashboard lists it. */
export interface PullSummary {
  number: number;
  title: string;
  draft: boolean;
  html_url: string;
  updated_at: string;
  user: { login: string; avatar_url?: string } | null;
  head: { sha: string; ref: string; repo: { id: number } | null };
  base: { ref: string };
  author_association: string;
}

export interface CheckOutput {
  title: string;
  summary: string;
  text?: string;
}

export type CheckConclusion = "success" | "failure" | "neutral" | "cancelled" | "action_required";

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
}

export class Installation {
  private readonly auth: () => Promise<string>;

  constructor(
    private readonly app: GitHubApp,
    readonly id: number,
    private readonly http: HttpOptions,
  ) {
    this.auth = () => app.token(id);
  }

  /** A token that can only read one repository's contents: what a scan's clone gets. */
  cloneToken(repositoryId: number): Promise<string> {
    return this.app.token(this.id, { repositoryIds: [repositoryId], permissions: { contents: "read" } });
  }

  repositories(): Promise<InstalledRepository[]> {
    return githubPaginate(this.auth, "/installation/repositories", (page: { repositories: InstalledRepository[] }) => page.repositories, {}, this.http);
  }

  /** The installed account's public profile: what GitHub shows on its page. */
  account(login: string, type: "User" | "Organization"): Promise<AccountProfile> {
    return githubRequest(this.auth, `/${type === "Organization" ? "orgs" : "users"}/${encodeURIComponent(login)}`, {}, this.http);
  }

  pull(repo: string, number: number): Promise<{ number: number; state: "open" | "closed"; head: { sha: string; repo: { full_name: string } | null }; base: { sha: string; ref: string }; user: { login: string }; draft: boolean }> {
    return githubRequest(this.auth, `/repos/${repo}/pulls/${number}`, {}, this.http);
  }

  /** Changed files with their patches. GitHub returns at most 3,000. */
  pullFiles(repo: string, number: number, signal?: AbortSignal): Promise<PullFile[]> {
    return githubPaginate(this.auth, `/repos/${repo}/pulls/${number}/files`, (page: PullFile[]) => page, { limit: 3_000, signal }, this.http);
  }

  /** Files changed between two commits (at most 300, GitHub's limit). */
  async compare(repo: string, base: string, head: string): Promise<PullFile[]> {
    const result = await githubRequest<{ files?: PullFile[] }>(this.auth, `/repos/${repo}/compare/${base}...${head}`, {}, this.http);
    return result.files ?? [];
  }

  async createCheckRun(repo: string, input: { name: string; headSha: string; externalId: string; detailsUrl?: string; output: CheckOutput }): Promise<number> {
    const result = await githubRequest<{ id: number }>(
      this.auth,
      `/repos/${repo}/check-runs`,
      {
        method: "POST",
        body: { name: input.name, head_sha: input.headSha, external_id: input.externalId, details_url: input.detailsUrl, status: "in_progress", output: input.output },
      },
      this.http,
    );
    return result.id;
  }

  async completeCheckRun(repo: string, checkRunId: number, conclusion: CheckConclusion, output: CheckOutput): Promise<void> {
    await githubRequest(
      this.auth,
      `/repos/${repo}/check-runs/${checkRunId}`,
      { method: "PATCH", body: { status: "completed", conclusion, completed_at: new Date().toISOString(), output } },
      this.http,
    );
  }

  /** One review holding every inline comment, so the PR gets one notification. */
  async createReview(repo: string, number: number, input: { commitId: string; body: string; comments: ReviewComment[] }): Promise<void> {
    await githubRequest(
      this.auth,
      `/repos/${repo}/pulls/${number}/reviews`,
      { method: "POST", body: { commit_id: input.commitId, event: "COMMENT", body: input.body, comments: input.comments } },
      this.http,
    );
  }

  /** The commit a branch points at. */
  async branchSha(repo: string, branch: string): Promise<string> {
    const result = await githubRequest<{ commit: { sha: string } }>(this.auth, `/repos/${repo}/branches/${encodeURIComponent(branch)}`, {}, this.http);
    return result.commit.sha;
  }

  /** Posts a comment on an issue or pull request; returns its id. */
  async comment(repo: string, issueNumber: number, body: string): Promise<number> {
    const result = await githubRequest<{ id: number }>(this.auth, `/repos/${repo}/issues/${issueNumber}/comments`, { method: "POST", body: { body } }, this.http);
    return result.id;
  }

  /** Replaces a comment's text. A comment someone deleted throws a 404 `GitHubError`. */
  async editComment(repo: string, commentId: number, body: string): Promise<void> {
    await githubRequest(this.auth, `/repos/${repo}/issues/comments/${commentId}`, { method: "PATCH", body: { body } }, this.http);
  }

  /** The most recently updated open pull requests: one page, since each one carries both repositories in full. */
  pulls(repo: string, limit = 30, signal?: AbortSignal): Promise<PullSummary[]> {
    return githubRequest(this.auth, `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${Math.min(100, limit)}`, { signal }, this.http);
  }

  /**
   * The membership of whoever holds this username in the organisation now
   * (Members: read), or null when the membership endpoint says they are not a
   * member. A username can change hands, so callers must check `userId`
   * against the account they mean. Any other failure, including not getting
   * a token (an uninstalled app), is thrown: then nobody knows.
   */
  async orgMembership(org: string, username: string): Promise<{ userId: number; state: string; role: string } | null> {
    const token = await this.auth();
    try {
      const membership = await githubRequest<{ state: string; role: string; user: { id: number } }>(
        async () => token,
        `/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(username)}`,
        {},
        this.http,
      );
      return { userId: membership.user.id, state: membership.state, role: membership.role };
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  /** The user's permission on the repo: admin, maintain, write, triage, read or none. */
  async permission(repo: string, username: string): Promise<string> {
    const result = await githubRequest<{ permission: string; role_name?: string }>(this.auth, `/repos/${repo}/collaborators/${encodeURIComponent(username)}/permission`, {}, this.http);
    return result.role_name ?? result.permission;
  }
}
