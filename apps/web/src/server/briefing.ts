/**
 * The briefing recruiting shows for an org: its GitHub profile and
 * repositories (with languages from GitHub and sizes from recon), and what
 * was saved last time. GitHub is asked at most every ten minutes per org,
 * and never holds the page up for more than a few seconds: without it the
 * briefing is built from what the database knows.
 */
import { adminOrgs, orgForAdmin, orgRepos } from "@sandchest/db";
import type { AccountProfile, InstalledRepository } from "@sandchest/github";
import { type Briefing, type RecruitAccount, websiteUrl } from "@/lib/briefing";
import { readHacker } from "@/lib/hacker";
import { installationSettingsUrl } from "@/lib/installation";
import { db } from "./db";
import { githubApp } from "./github-app";
import { describeError } from "./log";

const TTL_MS = 10 * 60_000;
const WAIT_MS = 3_000;

type FromGitHub = { profile: AccountProfile | null; repos: Map<number, InstalledRepository> };
const cache = new Map<string, { at: number; value: Promise<FromGitHub> }>();

function fromGitHub(org: { id: string; githubLogin: string; type: "User" | "Organization"; installationId: number | null }): Promise<FromGitHub> {
  const hit = cache.get(org.id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const installation = org.installationId ? githubApp().installation(org.installationId) : null;
  const value = Promise.all([
    installation?.account(org.githubLogin, org.type).catch(logged("profile")) ?? null,
    installation?.repositories().catch(logged("repositories")) ?? null,
  ]).then(([profile, repos]) => ({ profile: profile ?? null, repos: new Map((repos ?? []).map((repo) => [repo.id, repo])) }));
  cache.set(org.id, { at: Date.now(), value });
  // A failed read isn't kept: the next page asks again.
  value.then((got) => {
    if (!got.profile) cache.delete(org.id);
  });
  return value;
}

function logged(what: string) {
  return (error: unknown) => {
    console.error(`Briefing ${what} read failed: ${describeError(error)}`);
    return null;
  };
}

/** GitHub's answer, or nothing if it takes longer than a page should wait. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/** The accounts a person can set up. */
export async function recruitAccounts(userId: string): Promise<RecruitAccount[]> {
  const rows = await adminOrgs(db(), userId);
  return rows.map((row) => ({ id: row.id, login: row.login, type: row.type, planId: row.planId ?? null, handle: row.settings.hacker ? readHacker(row.settings.hacker).handle : null }));
}

/** The briefing for an org the user administers, or undefined if they don't. */
export async function briefing(user: { id: string; email: string | null }, orgId: string): Promise<Briefing | undefined> {
  const row = await orgForAdmin(db(), user.id, orgId);
  if (!row) return undefined;
  const { org } = row;
  const [github, repos] = await Promise.all([within(fromGitHub(org), WAIT_MS, { profile: null, repos: new Map() }), orgRepos(db(), org.id)]);
  const profile = github.profile;
  const name = profile?.name?.trim() || org.githubLogin;
  const saved = org.settings.company;
  return {
    orgId: org.id,
    login: org.githubLogin,
    type: org.type,
    profile: {
      name,
      about: (profile?.description ?? profile?.bio)?.trim() || null,
      website: websiteUrl(profile?.blog),
      location: profile?.location?.trim() || null,
      avatar: profile?.avatar_url ?? `https://github.com/${encodeURIComponent(org.githubLogin)}.png?size=128`,
    },
    repos: repos.map((repo) => {
      const details = github.repos.get(repo.githubRepoId);
      return { id: repo.id, fullName: repo.fullName, private: repo.private, loc: repo.loc, language: details?.language ?? null, description: details?.description?.trim() || null };
    }),
    chooseRepos: installationSettingsUrl({ login: org.githubLogin, type: org.type, installationId: org.installationId }),
    company: saved ?? { name, email: user.email && !user.email.endsWith("@users.noreply.github.com") ? user.email : "" },
    hacker: org.settings.hacker ? readHacker(org.settings.hacker) : null,
    currentPlan: row.billing?.planId ?? null,
  };
}
