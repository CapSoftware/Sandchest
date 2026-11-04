/**
 * What a scan needs from the forge a repository lives on, the same for each:
 * GitHub through the App's installation, Forgejo (or Gitea) through the bot
 * account. GitHub's Check runs become commit statuses on Forgejo, which has
 * no Checks.
 */
import type { Forge } from "@sandchest/db";
import { statusState } from "@sandchest/forgejo";
import type { CheckConclusion, CheckOutput, PullFile, ReviewComment } from "@sandchest/github";
import { config } from "./config";
import { forgejoClient } from "./forgejo";
import { githubApp } from "./github-app";

export interface RepoForge {
  /** Where to clone the repository from, and a token that can read it. The token never goes in a URL or argv. */
  cloneSource(repo: { githubRepoId: number; fullName: string }): Promise<{ url: string; token: string }>;
  /** The commit a branch points at. */
  branchSha(repo: string, branch: string): Promise<string>;
  /** A pull request's changed files with their patches. */
  pullFiles(repo: string, number: number, signal?: AbortSignal): Promise<PullFile[]>;
  /** Files changed between two commits. */
  compare(repo: string, base: string, head: string): Promise<PullFile[]>;
  /** Shows the review as in progress on the PR's head. Returns the id to complete it with. */
  createCheck(repo: string, input: { name: string; headSha: string; externalId: string; detailsUrl?: string; output: CheckOutput }): Promise<number>;
  completeCheck(repo: string, check: { id: number; name: string; headSha: string; prNumber: number | null; detailsUrl?: string }, conclusion: CheckConclusion, output: CheckOutput): Promise<void>;
  /** One review holding every inline comment. */
  createReview(repo: string, number: number, input: { commitId: string; body: string; comments: ReviewComment[] }): Promise<void>;
}

/** The forge for an org's repositories. `installationId` is the GitHub installation, or on Forgejo the covered account. */
export function forgeFor(provider: Forge, installationId: number): RepoForge {
  return provider === "forgejo" ? forgejo() : github(installationId);
}

function github(installationId: number): RepoForge {
  const installation = githubApp().installation(installationId);
  return {
    async cloneSource(repo) {
      const host = (config().SANDCHEST_GIT_HOST ?? "https://github.com").replace(/\/$/, "");
      return { url: `${host}/${repo.fullName}.git`, token: await installation.cloneToken(repo.githubRepoId) };
    },
    branchSha: (repo, branch) => installation.branchSha(repo, branch),
    pullFiles: (repo, number, signal) => installation.pullFiles(repo, number, signal),
    compare: (repo, base, head) => installation.compare(repo, base, head),
    createCheck: (repo, input) => installation.createCheckRun(repo, input),
    completeCheck: (repo, check, conclusion, output) => installation.completeCheckRun(repo, check.id, conclusion, output),
    createReview: (repo, number, input) => installation.createReview(repo, number, input),
  };
}

function forgejo(): RepoForge {
  const client = forgejoClient();
  if (!client) throw new Error("This repository is on Forgejo, and FORGEJO_URL is not set");
  return {
    // The bot's own token: Forgejo cannot mint a narrower one per scan.
    cloneSource: async (repo) => ({ url: `${client.config.gitUrl}/${repo.fullName}.git`, token: client.config.token }),
    branchSha: (repo, branch) => client.branchSha(repo, branch),
    pullFiles: (repo, number, signal) => client.pullFiles(repo, number, signal),
    compare: (repo, base, head) => client.compare(repo, base, head),
    createCheck: (repo, input) => client.setStatus(repo, input.headSha, { state: "pending", context: input.name, description: input.output.title, targetUrl: input.detailsUrl }),
    async completeCheck(repo, check, conclusion, output) {
      await client.setStatus(repo, check.headSha, { state: statusState(conclusion), context: check.name, description: output.title, targetUrl: check.detailsUrl });
      // A status holds one line. When it is not a pass, the PR also gets the summary a Check would show.
      if (conclusion !== "success" && check.prNumber) await client.comment(repo, check.prNumber, `**Sandchest: ${output.title}**\n\n${output.summary}`);
    },
    createReview: (repo, number, input) => client.createReview(repo, number, input),
  };
}
