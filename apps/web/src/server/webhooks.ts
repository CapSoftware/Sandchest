/**
 * GitHub webhook handling. Answers fast: database writes and workflow
 * starts only; everything slow happens in the scan workflow.
 */
import {
  claimDelivery,
  createScan,
  disableRepos,
  openFindings,
  queuePendingRecons,
  removeInstallation,
  repoByGithubId,
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

export interface WebhookDeps {
  db: Db;
  github: GitHubApp;
  /** Starts the scan workflow for a scan record. */
  startScan(scanId: string): Promise<void>;
  /**
   * Whether the org may scan (has a plan). Recon waits until it does: buying a
   * plan starts it. Omitted means billing is off.
   */
  hasPlan?(org: { id: string; githubLogin: string }): Promise<boolean>;
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
    await removeInstallation(deps.db, installation.id);
    return { status: "handled", detail: "installation removed" };
  }
  if (payload.action !== "created" && payload.action !== "unsuspend" && payload.action !== "new_permissions_accepted") {
    return { status: "ignored", detail: `installation.${payload.action}` };
  }
  if (installation.account.type === "Bot") return { status: "ignored", detail: "bot account" };
  const org = await recordInstallation(deps, { id: installation.id, account: { ...installation.account, type: installation.account.type } });
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
  if (payload.repositories_added.length === 0) return { status: "handled" };
  const added = new Set(payload.repositories_added.map((r) => r.id));
  const details = (await deps.github.installation(payload.installation.id).repositories()).filter((r) => added.has(r.id));
  const existing = await repoByGithubId(deps.db, payload.repositories_added[0]!.id);
  const org = existing?.org ?? (await deps.db.query.orgs.findFirst({ where: (orgs, { eq }) => eq(orgs.installationId, payload.installation.id) }));
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
  if (deps.hasPlan && !(await deps.hasPlan(org))) return { status: "handled", scans: [], detail: "recon waits for a plan" };
  // "HEAD" is resolved to the default branch's commit when the scan clones.
  const scans = await queuePendingRecons(deps.db, org.id);
  for (const id of scans) await deps.startScan(id);
  return { status: "handled", scans };
}

async function onPullRequest(deps: WebhookDeps, payload: PullRequestEvent): Promise<WebhookOutcome> {
  if (!REVIEWED_ACTIONS.has(payload.action)) return { status: "ignored", detail: `pull_request.${payload.action}` };
  const pr = payload.pull_request;
  if (pr.draft) return { status: "ignored", detail: "draft" };
  const repo = await repoByGithubId(deps.db, payload.repository.id);
  if (!repo?.enabled || !repo.org.installationId) return { status: "ignored", detail: "repo not enabled" };

  // Fork PRs on public repos need a maintainer's `/sandchest review`; elsewhere, trusted authors are reviewed automatically.
  const fork = pr.head.repo?.id !== payload.repository.id;
  if (fork && !repo.private) return { status: "ignored", detail: "public fork PR: waiting for /sandchest review" };
  if (fork && !TRUSTED_AUTHORS.has(pr.author_association)) return { status: "ignored", detail: "fork PR from an untrusted author" };

  const scanId = await newScan(deps, { repoId: repo.id, orgId: repo.orgId, kind: "pr_review", headSha: pr.head.sha, baseSha: pr.base.sha, prNumber: pr.number });
  return { status: "handled", scans: scanId ? [scanId] : [] };
}

async function onPush(deps: WebhookDeps, payload: PushEvent): Promise<WebhookOutcome> {
  const branch = payload.repository.default_branch;
  if (payload.deleted || payload.ref !== `refs/heads/${branch}` || /^0+$/.test(payload.after)) return { status: "ignored", detail: "not the default branch" };
  const repo = await repoByGithubId(deps.db, payload.repository.id);
  if (!repo?.enabled || !repo.org.installationId) return { status: "ignored", detail: "repo not enabled" };

  const scans: string[] = [];
  if (!(await threatModel(deps.db, repo.id))) {
    scans.push(await newScan(deps, { repoId: repo.id, orgId: repo.orgId, kind: "recon", headSha: payload.after }));
  }
  if ((await openFindings(deps.db, repo.id)).length > 0) {
    scans.push(await newScan(deps, { repoId: repo.id, orgId: repo.orgId, kind: "fix_check", headSha: payload.after, baseSha: payload.before }));
  }
  return { status: scans.length ? "handled" : "ignored", detail: scans.length ? undefined : "nothing to check", scans: scans.filter(Boolean) };
}

async function onIssueComment(deps: WebhookDeps, payload: IssueCommentEvent): Promise<WebhookOutcome> {
  if (payload.action !== "created" || !payload.issue.pull_request || !REVIEW_COMMAND.test(payload.comment.body)) {
    return { status: "ignored", detail: "not a review command" };
  }
  if (payload.comment.user.type === "Bot") return { status: "ignored", detail: "bot comment" };
  const repo = await repoByGithubId(deps.db, payload.repository.id);
  if (!repo?.enabled || !repo.org.installationId) return { status: "ignored", detail: "repo not enabled" };

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
 * before a redelivery) is started now.
 */
async function newScan(
  deps: WebhookDeps,
  input: { repoId: string; orgId: string; kind: ScanKind; headSha: string; baseSha?: string; prNumber?: number; trigger?: "webhook" | "manual" },
): Promise<string> {
  const { scan, created } = await createScan(deps.db, { trigger: "webhook", ...input });
  const orphaned = !created && scan.status === "queued" && !scan.workflowRunId;
  if (!created && !orphaned) return "";
  await deps.startScan(scan.id);
  return scan.id;
}
