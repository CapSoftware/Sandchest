/**
 * Forgejo (and Gitea) webhook handling, with the same rules as GitHub's:
 * pull requests are reviewed, pushes to the default branch build the threat
 * model and re-check open findings, and `/sandchest review` reviews a pull
 * request from a fork. Answers fast; the scan workflow does the rest.
 */
import { claimDelivery, disableRepos, hasOpenFindings, repoByGithubId, threatModel, type Org, type Repo } from "@sandchest/db";
import type { IssueCommentEvent, PullRequestEvent, PushEvent, Repository, RepositoryEvent } from "@sandchest/forgejo";
import { covers, recordForgejoRepo, type ForgejoDeps } from "./forgejo-sync";
import { newScan, REVIEW_COMMAND, type WebhookOutcome } from "./webhooks";

/** Forgejo's actions for a pull request worth reviewing. `edited` covers taking "WIP:" off a draft; a head already reviewed is not reviewed again. */
const REVIEWED_ACTIONS = new Set(["opened", "synchronized", "reopened", "edited"]);
const WRITE_ROLES = new Set(["admin", "write"]);
/** Forgejo's default work-in-progress prefixes, for versions whose API has no `draft`. */
const DRAFT_TITLE = /^\s*(wip:|\[wip\])/i;

/** Handles one delivery exactly once. If handling fails, the claim is released so a redelivery is processed. */
export async function handleForgejoWebhook(deps: ForgejoDeps, event: string, deliveryId: string, payload: unknown): Promise<WebhookOutcome> {
  // Prefixed: GitHub's and Forgejo's delivery ids share the table.
  const id = `forgejo:${deliveryId}`;
  if (!(await claimDelivery(deps.db, id, event))) return { status: "duplicate" };
  try {
    return await dispatch(deps, event, payload);
  } catch (error) {
    await deps.db.$client`delete from webhook_deliveries where id = ${id}`;
    throw error;
  }
}

async function dispatch(deps: ForgejoDeps, event: string, payload: unknown): Promise<WebhookOutcome> {
  switch (event) {
    case "pull_request":
      return onPullRequest(deps, payload as PullRequestEvent);
    case "push":
      return onPush(deps, payload as PushEvent);
    case "issue_comment":
      return onIssueComment(deps, payload as IssueCommentEvent);
    case "repository":
      return onRepository(deps, payload as RepositoryEvent);
    default:
      return { status: "ignored", detail: `event ${event}` };
  }
}

/**
 * The covered, enabled repository an event is about. One Sandchest has not
 * seen yet is recorded first, which starts its recon (`recorded`).
 */
async function coveredRepo(deps: ForgejoDeps, repository: Repository): Promise<((Repo & { org: Org }) & { recorded: boolean }) | undefined> {
  if (!covers(deps.forgejo.config, repository.full_name)) return undefined;
  let repo = await repoByGithubId(deps.db, repository.id, "forgejo");
  const recorded = !repo;
  if (recorded) {
    await recordForgejoRepo(deps, repository.full_name);
    repo = await repoByGithubId(deps.db, repository.id, "forgejo");
  }
  return repo?.enabled && repo.org.installationId ? { ...repo, recorded } : undefined;
}

async function onPullRequest(deps: ForgejoDeps, payload: PullRequestEvent): Promise<WebhookOutcome> {
  if (!REVIEWED_ACTIONS.has(payload.action)) return { status: "ignored", detail: `pull_request.${payload.action}` };
  const pr = payload.pull_request;
  if (pr.draft ?? DRAFT_TITLE.test(pr.title)) return { status: "ignored", detail: "draft" };
  const repo = await coveredRepo(deps, payload.repository);
  if (!repo) return { status: "ignored", detail: "repo not enabled" };

  // Fork PRs on public repos need a maintainer's `/sandchest review`. Elsewhere, authors with write access are
  // reviewed automatically: Forgejo has no author association, so it is asked.
  const fork = pr.head.repo_id !== pr.base.repo_id;
  if (fork && !repo.private) return { status: "ignored", detail: "public fork PR: waiting for /sandchest review" };
  if (fork && !WRITE_ROLES.has(await deps.forgejo.permission(repo.fullName, pr.user.login))) return { status: "ignored", detail: "fork PR from an untrusted author" };

  const scanId = await newScan(deps, { repoId: repo.id, orgId: repo.orgId, kind: "pr_review", headSha: pr.head.sha, baseSha: pr.base.sha, prNumber: pr.number });
  return { status: "handled", scans: scanId ? [scanId] : [] };
}

async function onPush(deps: ForgejoDeps, payload: PushEvent): Promise<WebhookOutcome> {
  const branch = payload.repository.default_branch;
  if (payload.ref !== `refs/heads/${branch}` || /^0+$/.test(payload.after)) return { status: "ignored", detail: "not the default branch" };
  const repo = await coveredRepo(deps, payload.repository);
  if (!repo) return { status: "ignored", detail: "repo not enabled" };

  const scans: string[] = [];
  const [model, open] = await Promise.all([threatModel(deps.db, repo.id), hasOpenFindings(deps.db, repo.id)]);
  // Recording a new repository has started its recon already.
  if (!model && !repo.recorded) {
    scans.push(await newScan(deps, { repoId: repo.id, orgId: repo.orgId, kind: "recon", headSha: payload.after }));
  }
  // A first push to an empty repository has nothing before it to compare with.
  if (open && !/^0+$/.test(payload.before)) {
    scans.push(await newScan(deps, { repoId: repo.id, orgId: repo.orgId, kind: "fix_check", headSha: payload.after, baseSha: payload.before }));
  }
  return { status: scans.length ? "handled" : "ignored", detail: scans.length ? undefined : "nothing to check", scans: scans.filter(Boolean) };
}

async function onIssueComment(deps: ForgejoDeps, payload: IssueCommentEvent): Promise<WebhookOutcome> {
  const onPull = payload.is_pull ?? !!payload.issue.pull_request;
  if (payload.action !== "created" || !onPull || !REVIEW_COMMAND.test(payload.comment.body)) return { status: "ignored", detail: "not a review command" };
  const repo = await coveredRepo(deps, payload.repository);
  if (!repo) return { status: "ignored", detail: "repo not enabled" };

  const role = await deps.forgejo.permission(repo.fullName, payload.comment.user.login);
  if (!WRITE_ROLES.has(role)) return { status: "ignored", detail: "commenter lacks write access" };
  const pr = await deps.forgejo.pull(repo.fullName, payload.issue.number);
  const scanId = await newScan(deps, { repoId: repo.id, orgId: repo.orgId, kind: "pr_review", headSha: pr.head.sha, baseSha: pr.base.sha, prNumber: pr.number, trigger: "manual" });
  return { status: "handled", scans: scanId ? [scanId] : [] };
}

async function onRepository(deps: ForgejoDeps, payload: RepositoryEvent): Promise<WebhookOutcome> {
  if (payload.action === "deleted") {
    await disableRepos(deps.db, [payload.repository.id], "forgejo");
    return { status: "handled", detail: "repository removed" };
  }
  // A new repository is empty: it is recorded on its first push, or by the next sync.
  return { status: "ignored", detail: `repository.${payload.action}` };
}
