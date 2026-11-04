/**
 * Which Forgejo repositories Sandchest covers. Forgejo has no App to install:
 * the operator lists owners (users or organisations) and single repositories
 * in FORGEJO_OWNERS, and the bot's view of them is recorded the way a GitHub
 * installation is. Each owner is an org whose "installation id" is its own
 * Forgejo id. Run by the sweep, so a new repository is picked up within ten
 * minutes, and by a webhook from a repository not seen before.
 */
import { disableRepos, installedOrgs, orgByInstallation, orgRepos, removeInstallation, upsertInstallation, type Org } from "@sandchest/db";
import type { Forgejo, ForgejoConfig } from "@sandchest/forgejo";
import type { InstalledRepository } from "@sandchest/github";
import { billingEnabled, canScan } from "./billing";
import { config } from "./config";
import { forgejoClient } from "./forgejo";
import { describeError } from "./log";
import { db } from "./services";
import { startScan } from "./start";
import { startRecon, type WebhookDeps } from "./webhooks";

export interface ForgejoDeps extends Pick<WebhookDeps, "db" | "startScan" | "canScan"> {
  forgejo: Forgejo;
  /** Where Forgejo sends events: `<SANDCHEST_APP_URL>/api/forgejo/webhooks`. */
  webhookUrl: string;
}

/** What webhooks and the sync need, or undefined when this deployment does not use Forgejo. */
export function forgejoDeps(): ForgejoDeps | undefined {
  const forgejo = forgejoClient();
  if (!forgejo) return undefined;
  const webhookUrl = `${config().SANDCHEST_APP_URL.replace(/\/$/, "")}/api/forgejo/webhooks`;
  return { db: db(), forgejo, startScan, canScan: billingEnabled() ? canScan : undefined, webhookUrl };
}

/** Whether FORGEJO_OWNERS covers a repository. Forgejo's names are case-insensitive. */
export function covers(config: Pick<ForgejoConfig, "owners">, fullName: string): boolean {
  const [owner, repo] = fullName.toLowerCase().split("/");
  return config.owners.some((entry) => entry.owner.toLowerCase() === owner && (!entry.repo || entry.repo.toLowerCase() === repo));
}

/** FORGEJO_OWNERS by owner: every repository (`repos` undefined), or the ones named. */
function scopes(config: Pick<ForgejoConfig, "owners">): Map<string, { owner: string; repos?: string[] }> {
  const byOwner = new Map<string, { owner: string; repos?: string[] }>();
  for (const entry of config.owners) {
    const key = entry.owner.toLowerCase();
    const scope = byOwner.get(key) ?? byOwner.set(key, { owner: entry.owner, repos: [] }).get(key)!;
    if (!entry.repo) scope.repos = undefined;
    else scope.repos?.push(entry.repo);
  }
  return byOwner;
}

/**
 * Records every covered owner and repository, adds missing webhooks (unless
 * FORGEJO_WEBHOOKS=manual), starts recon where it is due, and forgets owners
 * no longer listed, as an uninstall does. One owner failing leaves the rest
 * to finish.
 */
export async function syncForgejo(deps: ForgejoDeps): Promise<{ owners: number; failed: number; removed: number }> {
  const wanted = scopes(deps.forgejo.config);
  let failed = 0;
  for (const scope of wanted.values()) {
    try {
      await syncOwner(deps, scope.owner, scope.repos, { partial: false });
    } catch (error) {
      failed++;
      console.error(`Forgejo sync of an owner failed: ${describeError(error)}`);
    }
  }
  let removed = 0;
  for (const org of await installedOrgs(deps.db, "forgejo")) {
    if (wanted.has(org.githubLogin.toLowerCase()) || !org.installationId) continue;
    await removeInstallation(deps.db, org.installationId, "forgejo");
    removed++;
  }
  return { owners: wanted.size, failed, removed };
}

/** Records one covered repository Sandchest has not seen yet (a webhook from it came first) and starts its recon. */
export async function recordForgejoRepo(deps: ForgejoDeps, fullName: string): Promise<Org | undefined> {
  if (!covers(deps.forgejo.config, fullName)) return undefined;
  const [owner, repo] = fullName.split("/");
  return syncOwner(deps, owner!, [repo!], { partial: true });
}

/**
 * Records an owner's covered repositories, and starts recon when any of them
 * is new or enabled again. Unless `partial`, its other repositories are
 * disabled (gone, archived, or no longer listed), like repositories removed
 * from a GitHub installation.
 */
async function syncOwner(deps: ForgejoDeps, name: string, only: string[] | undefined, options: { partial: boolean }): Promise<Org> {
  const { forgejo, db } = deps;
  const owner = await forgejo.owner(name);
  const repos: InstalledRepository[] = only
    ? (await Promise.all(only.map((repo) => forgejo.repository(`${owner.login}/${repo}`)))).filter((repo) => !repo.empty)
    : await forgejo.repositories(owner);
  // An owner's "installation id" is its own Forgejo id.
  const known = await orgByInstallation(db, owner.id, "forgejo");
  const enabled = new Set(known ? (await orgRepos(db, known.id)).map((repo) => repo.githubRepoId) : []);
  const { org } = await upsertInstallation(
    db,
    owner.id,
    { provider: "forgejo", githubAccountId: owner.id, githubLogin: owner.login, type: owner.type },
    repos.map((r) => ({ githubRepoId: r.id, fullName: r.full_name, private: r.private, defaultBranch: r.default_branch })),
  );
  if (!options.partial) {
    const listed = new Set(repos.map((repo) => repo.id));
    await disableRepos(db, (await orgRepos(db, org.id)).filter((repo) => !listed.has(repo.githubRepoId)).map((repo) => repo.githubRepoId), "forgejo");
    if (forgejo.config.manageWebhooks) await addWebhooks(deps, !only && owner.type === "Organization" ? [{ org: owner.login }] : repos.map((repo) => ({ repo: repo.full_name })), org.id);
  }
  // Only for repositories new or back since the last sync: the sweep runs every ten minutes, and would otherwise retry a failed recon each time.
  if (repos.some((repo) => !enabled.has(repo.id))) await startRecon(deps, org);
  return org;
}

/** One webhook on a whole organisation, or one per repository (single repositories, and users, who have no account-wide webhooks). */
async function addWebhooks(deps: ForgejoDeps, targets: Array<{ org: string } | { repo: string }>, orgId: string): Promise<void> {
  for (const target of targets) {
    // The bot needs to own the organisation, or administer the repository. Without that, the operator adds the webhook.
    await deps.forgejo.ensureWebhook(target, deps.webhookUrl).catch((error: unknown) => console.error(`Adding a Forgejo webhook for org ${orgId} failed: ${describeError(error)}`));
  }
}
