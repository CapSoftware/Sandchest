/**
 * GitHub webhook handling. Answers fast: database writes and workflow
 * starts only; everything slow happens in the scan workflow.
 */
import {
  claimDelivery,
  createScan,
  disableRepos,
  hasOpenFindings,
  lastPrReviewRefused,
  orgByInstallation,
  queuePendingRecons,
  queuePushScan,
  recordEvent,
  removeInstallation,
  repoByGithubId,
  requestInventory,
  threatModel,
  upsertInstallation,
  upsertRepos,
  type Db,
  type ScanKind,
} from "@sandchest/db";
import type {
  GitHubApp,
  InstallationEvent,
  InstallationRepositoriesEvent,
  IssueCommentEvent,
  PullRequestEvent,
  PushEvent,
} from "@sandchest/github";
import { isDependencyManifest } from "@sandchest/engine/scan";

export interface WebhookDeps {
  db: Db;
  github: GitHubApp;
  /** Starts the scan workflow for a scan record. */
  startScan(scanId: string): Promise<void>;
  /**
   * Whether the org may scan: a plan and credits left. Recon waits until it
   * can: buying a plan, or credits after running out, starts it. Omitted
   * means billing is off.
   */
  canScan?(org: { id: string; githubLogin: string }): Promise<boolean>;
  /** Starts a free re-read of a repository's dependency inventory (the CVE directory). Omitted: none. */
  startInventory?(repoId: string): Promise<void>;
}

export type WebhookOutcome = { status: "duplicate" | "ignored" | "handled"; detail?: string; scans?: string[] };

const REVIEWED_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
const TRUSTED_AUTHORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const WRITE_ROLES = new Set(["admin", "maintain", "write"]);
export const REVIEW_COMMAND = /^\s*\/sandchest\s+review\s*$/im;

/** Handles one delivery exactly once. If handling fails, the claim is released so a redelivery is processed. */
export async function handleWebhook(deps: WebhookDeps, event: string, deliveryId: string, payload: unknown): Promise<WebhookOutcome> {
  if (!(await claimDelivery(deps.db, deliveryId, event))) return { status: "duplicate" };
  try {
    return await dispatch(deps, event, payload);
  } catch (error) {
    await deps.db.$client`delete from webhook_deliveries where id = ${deliveryId}`;
    throw error;
  }
}

async function dispatch(deps: WebhookDeps, event: string, payload: unknown): Promise<WebhookOutcome> {
  switch (event) {
    case "installation":
      return onInstallation(deps, payload as InstallationEvent);
    case "installation_repositories":
      return onInstallationRepositories(deps, payload as InstallationRepositoriesEvent);
    case "pull_request":
      return onPullRequest(deps, payload as PullRequestEvent);
    case "push":
      return onPush(deps, payload as PushEvent);
    case "issue_comment":
      return onIssueComment(deps, payload as IssueCommentEvent);
    default:
      return { status: "ignored", detail: `event ${event}` };
  }
}

async function onInstallation(deps: WebhookDeps, payload: InstallationEvent): Promise<WebhookOutcome> {
  const { installation } = payload;
  if (payload.action === "deleted" || payload.action === "suspend") {
    const org = await removeInstallation(deps.db, installation.id);
    if (org) await recordEvent(deps.db, { name: "app_uninstalled", orgId: org.id, props: { action: payload.action } }).catch(() => {});
    return { status: "handled", detail: "installation removed" };
  }
  if (payload.action !== "created" && payload.action !== "unsuspend" && payload.action !== "new_permissions_accepted") {
    return { status: "ignored", detail: `installation.${payload.action}` };
  }
  if (installation.account.type === "Bot") return { status: "ignored", detail: "bot account" };
  const org = await recordInstallation(deps, { id: installation.id, account: { ...installation.account, type: installation.account.type } });
  if (payload.action !== "new_permissions_accepted") {
    const props = { action: payload.action, account_type: installation.account.type, repos: payload.repositories?.length ?? null };
    await recordEvent(deps.db, { name: "app_installed", orgId: org.id, props }).catch(() => {});
  }
  return startRecon(deps, org);
}

/**
 * Records an installation and its repositories. Run by the installation
 * webhook, and by an access refresh that finds an installation before its
 * webhook has arrived (someone back from installing on GitHub). Safe to run
 * twice: everything is an upsert. Recon is the caller's next step.
 */
export async function recordInstallation(
  deps: Pick<WebhookDeps, "db" | "github">,
  installation: { id: number; account: { id: number; login: string; type: "User" | "Organization" } },
): Promise<{ id: string; githubLogin: string; installationId: number | null }> {
  // The payload lacks default branches; one API listing has them for every repo.
  const repositories = await deps.github.installation(installation.id).repositories();
  const { org } = await upsertInstallation(
    deps.db,
    installation.id,
    { githubAccountId: installation.account.id, githubLogin: installation.account.login, type: installation.account.type },
    repositories.map((r) => ({ githubRepoId: r.id, fullName: r.full_name, private: r.private, defaultBranch: r.default_branch })),
  );
  return org;
}

async function onInstallationRepositories(deps: WebhookDeps, payload: InstallationRepositoriesEvent): Promise<WebhookOutcome> {
  await disableRepos(deps.db, payload.repositories_removed.map((r) => r.id));
  const known = await orgByInstallation(deps.db, payload.installation.id);
  if (known) {
    const props = { added: payload.repositories_added.length, removed: payload.repositories_removed.length };
    await recordEvent(deps.db, { name: "repos_changed", orgId: known.id, props }).catch(() => {});
  }
  if (payload.repositories_added.length === 0) return { status: "handled" };
  const added = new Set(payload.repositories_added.map((r) => r.id));
  const details = (await deps.github.installation(payload.installation.id).repositories()).filter((r) => added.has(r.id));
  const existing = await repoByGithubId(deps.db, payload.repositories_added[0]!.id);
  const org = existing?.org ?? known;
  if (!org) return { status: "ignored", detail: "unknown installation" };
  await upsertRepos(deps.db, org.id, details.map((r) => ({ githubRepoId: r.id, fullName: r.full_name, private: r.private, defaultBranch: r.default_branch })));
  return startRecon(deps, org);
}

/**
 * Recon for every repo of the org that has no threat model and none on the
 * way, once the org has a plan. Queued in one serialised step, so it never
 * doubles up with the recon that buying a plan starts.
 */
export async function startRecon(deps: WebhookDeps, org: { id: string; githubLogin: string }): Promise<WebhookOutcome> {
  if (deps.canScan && !(await deps.canScan(org))) return { status: "handled", scans: [], detail: "recon waits for a plan and credits" };
  // "HEAD" is resolved to the default branch's commit when the scan clones.
  const scans = await queuePendingRecons(deps.db, org.id);
  // Started together: each start is idempotent (claimWorkflowStart), so a failure that brings a redelivery repeats nothing.
  await Promise.all(scans.map((id) => deps.startScan(id)));
  return { status: "handled", scans };
}

async function onPullRequest(deps: WebhookDeps, payload: PullRequestEvent): Promise<WebhookOutcome> {
  if (!REVIEWED_ACTIONS.has(payload.action)) return { status: "ignored", detail: `pull_request.${payload.action}` };
  const pr = payload.pull_request;
  if (pr.draft) return { status: "ignored", detail: "draft" };
  const repo = await repoByGithubId(deps.db, payload.repository.id);
  if (!repo?.enabled || !repo.org.installationId) return { status: "ignored", detail: "repo not enabled" };
  // The repo's choice: review every push, only when asked (`/sandchest review` or the dashboard), or never.
  if (repo.prReviews !== "auto") return { status: "ignored", detail: `pr reviews: ${repo.prReviews}` };

  // Fork PRs on public repos need a maintainer's `/sandchest review`. On a private repo anyone who can read it can fork it,
  // so a fork's PR is reviewed (and paid for) automatically only if its author could push the branch to the repo itself.
  const fork = pr.head.repo?.id !== payload.repository.id;
  if (fork && !repo.private) return { status: "ignored", detail: "public fork PR: waiting for /sandchest review" };
  if (fork && !TRUSTED_AUTHORS.has(pr.author_association)) return { status: "ignored", detail: "fork PR from an untrusted author" };
  if (fork && !WRITE_ROLES.has(await deps.github.installation(repo.org.installationId).permission(repo.fullName, pr.user.login))) {
    return { status: "ignored", detail: "fork PR from an author without write access: waiting for /sandchest review" };
  }

  // Refused once on this PR and still unable to pay: the PR already has a Check saying why, so later pushes don't
  // stack another refusal on it. Buying a plan or credits lets the next push run.
  if (deps.canScan && (await lastPrReviewRefused(deps.db, repo.id, pr.number)) && !(await deps.canScan(repo.org))) {
    return { status: "ignored", detail: "pr review already refused on this PR: waiting for a plan or credits" };
  }

  const scanId = await newScan(deps, { repoId: repo.id, orgId: repo.orgId, kind: "pr_review", headSha: pr.head.sha, baseSha: pr.base.sha, prNumber: pr.number });
  return { status: "handled", scans: scanId ? [scanId] : [] };
}

async function onPush(deps: WebhookDeps, payload: PushEvent): Promise<WebhookOutcome> {
  const branch = payload.repository.default_branch;
  if (payload.deleted || payload.ref !== `refs/heads/${branch}` || /^0+$/.test(payload.after)) return { status: "ignored", detail: "not the default branch" };
  const repo = await repoByGithubId(deps.db, payload.repository.id);
  if (!repo?.enabled || !repo.org.installationId) return { status: "ignored", detail: "repo not enabled" };

  const scans: string[] = [];
  const [model, open] = await Promise.all([threatModel(deps.db, repo.id), hasOpenFindings(deps.db, repo.id)]);
  if (!model) {
    scans.push(await newScan(deps, { repoId: repo.id, orgId: repo.orgId, kind: "recon", headSha: payload.after }));
  }
  if (open) {
    scans.push(await newScan(deps, { repoId: repo.id, orgId: repo.orgId, kind: "fix_check", headSha: payload.after, baseSha: payload.before }));
  }
  // A mapped repository whose manifests or lockfiles changed: what it installs may have, so the CVE directory reads it again.
  if (model && deps.startInventory && changesDependencies(payload)) {
    await requestInventory(deps.db, repo.id);
    // The request is stored: if the start fails, the sweep starts it. The scans above must not be redelivered for it.
    await deps.startInventory(repo.id).catch((error: unknown) => console.error(`Inventory refresh for repo ${repo.id} not started: ${error instanceof Error ? error.message : String(error)}`));
  }
  return { status: scans.length ? "handled" : "ignored", detail: scans.length ? undefined : "nothing to check", scans: scans.filter(Boolean) };
}

/** Whether a push may have changed what is installed. GitHub lists at most 20 commits, so a longer push counts. */
function changesDependencies(payload: PushEvent): boolean {
  const commits = payload.commits ?? [];
  if (payload.forced || commits.length === 0 || commits.length >= 20) return true;
  return commits.some((commit) => [...(commit.added ?? []), ...(commit.modified ?? []), ...(commit.removed ?? [])].some(isDependencyManifest));
}

async function onIssueComment(deps: WebhookDeps, payload: IssueCommentEvent): Promise<WebhookOutcome> {
  if (payload.action !== "created" || !payload.issue.pull_request || !REVIEW_COMMAND.test(payload.comment.body)) {
    return { status: "ignored", detail: "not a review command" };
  }
  if (payload.comment.user.type === "Bot") return { status: "ignored", detail: "bot comment" };
  const repo = await repoByGithubId(deps.db, payload.repository.id);
  if (!repo?.enabled || !repo.org.installationId) return { status: "ignored", detail: "repo not enabled" };
  if (repo.prReviews === "off") return { status: "ignored", detail: "pr reviews: off" };

  const installation = deps.github.installation(repo.org.installationId);
  const role = await installation.permission(repo.fullName, payload.comment.user.login);
  if (!WRITE_ROLES.has(role)) return { status: "ignored", detail: "commenter lacks write access" };
  const pr = await installation.pull(repo.fullName, payload.issue.number);
  const scanId = await newScan(deps, { repoId: repo.id, orgId: repo.orgId, kind: "pr_review", headSha: pr.head.sha, baseSha: pr.base.sha, prNumber: pr.number, trigger: "manual" });
  return { status: "handled", scans: scanId ? [scanId] : [] };
}

/**
 * Creates a scan and starts its workflow. A PR head already under review is
 * not started twice, but one whose workflow never started (a failed start
 * before a redelivery) is started now. Free scans fold into one already on
 * the way (`queuePushScan`): they cost nothing, so pushes must not multiply them.
 */
async function newScan(
  deps: WebhookDeps,
  input: { repoId: string; orgId: string; kind: ScanKind; headSha: string; baseSha?: string; prNumber?: number; trigger?: "webhook" | "manual" },
): Promise<string> {
  const values = { trigger: "webhook" as const, ...input };
  const { scan, created } =
    values.kind === "recon" || values.kind === "fix_check" ? await queuePushScan(deps.db, { ...values, kind: values.kind }) : await createScan(deps.db, values);
  const orphaned = !created && scan.status === "queued" && !scan.workflowRunId;
  if (!created && !orphaned) return "";
  await deps.startScan(scan.id);
  return scan.id;
}
