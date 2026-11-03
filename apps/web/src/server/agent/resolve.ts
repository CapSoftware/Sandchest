/**
 * Finding what an agent names, among what its person may see: accounts by
 * id or GitHub login, repositories by id or `owner/name`. Every lookup is
 * scoped to the person in SQL, exactly as the dashboard's are.
 */
import { orgForAdmin, repoForUser, settingsOrgs, visibleRepos, type SettingsOrg } from "@sandchest/db";
import { isUuid } from "@/lib/uuid";
import { db } from "../db";
import { ApiError, notAdmin, notFound } from "./errors";
import type { Context } from "./operation";

/** The accounts a person can see (admin of, or push access to a repository in), installed ones only. */
export function visibleAccounts(context: Context): Promise<SettingsOrg[]> {
  return settingsOrgs(db(), context.principal.userId);
}

export async function resolveAccount(context: Context, ref: string): Promise<SettingsOrg> {
  const accounts = await visibleAccounts(context);
  const wanted = ref.toLowerCase();
  const account = accounts.find((org) => (isUuid(ref) ? org.id === wanted : org.login.toLowerCase() === wanted));
  if (!account) {
    throw new ApiError(404, "account_not_found", `Sandchest isn't installed on a GitHub account called "${ref}" that you can see. Call list_accounts to see the accounts, or install the GitHub App first.`);
  }
  return account;
}

/** An account the person administers, with its stored billing. */
export async function resolveAdminAccount(context: Context, ref: string) {
  const account = await resolveAccount(context, ref);
  if (!account.admin) throw notAdmin(account.login);
  const row = await orgForAdmin(db(), context.principal.userId, account.id);
  if (!row) throw notAdmin(account.login);
  return row;
}

export async function resolveRepo(context: Context, ref: string) {
  let id = ref;
  if (!isUuid(ref)) {
    const wanted = ref.replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/, "").toLowerCase();
    const match = (await visibleRepos(db(), context.principal.userId)).find((repo) => repo.fullName.toLowerCase() === wanted);
    if (!match) throw repoNotFound(ref);
    id = match.id;
  }
  const row = await repoForUser(db(), context.principal.userId, id.toLowerCase());
  if (!row || !row.repo.enabled) throw repoNotFound(ref);
  return row;
}

const repoNotFound = (ref: string) =>
  new ApiError(
    404,
    "repo_not_found",
    `No repository "${ref}" that you can see. Sandchest shows repositories where its GitHub App is installed and you have push access. Call list_repos to see them.`,
  );

export { notFound };
