/**
 * What recruiting knows about the accounts a person can set up, and about the
 * one they chose: read from GitHub so the flow speaks about their own company
 * and code. Shared by the server, which builds it, and the recruit screens.
 */
import { DEEP_SCAN_TIERS, deepScanCredits } from "@sandchest/billing/costs";
import type { HackerProfile } from "./hacker";

/** An installed GitHub account the person administers. */
export interface RecruitAccount {
  id: string;
  login: string;
  type: "User" | "Organization";
  planId: string | null;
  /** The org's hacker's handle, if it has one already. */
  handle: string | null;
}

export interface BriefingRepo {
  id: string;
  fullName: string;
  private: boolean;
  /** Hand-written lines, once recon has measured them. */
  loc: number | null;
  language: string | null;
  description: string | null;
}

export interface Briefing {
  orgId: string;
  login: string;
  type: "User" | "Organization";
  /** GitHub's public profile of the account. */
  profile: { name: string; about: string | null; website: string | null; location: string | null; avatar: string };
  repos: BriefingRepo[];
  /** Where an admin chooses, on GitHub, which repositories Sandchest can see. */
  chooseRepos: string | null;
  /** Who receipts are for: saved, or prefilled from GitHub and the person's own email. */
  company: { name: string; email: string };
  hacker: HackerProfile | null;
  currentPlan: string | null;
}

/** Credits for one deep scan of a repository, with an unmeasured one counted at the top tier. */
export function digCredits(repo: Pick<BriefingRepo, "loc">): number {
  return (repo.loc === null ? undefined : deepScanCredits(repo.loc)) ?? DEEP_SCAN_TIERS.at(-1)!.credits;
}

/** Credits for one deep scan of each repository, with unmeasured ones counted at the top tier. */
export function digAllCredits(repos: readonly Pick<BriefingRepo, "loc">[]): number {
  return repos.reduce((sum, repo) => sum + digCredits(repo), 0);
}

/** "42k lines", "1.2M lines", or nothing until recon has counted. */
export function linesLabel(loc: number | null): string | null {
  if (loc === null) return null;
  if (loc >= 1_000_000) return `${(loc / 1_000_000).toFixed(1).replace(/\.0$/, "")}M lines`;
  if (loc >= 1_000) return `${Math.round(loc / 1_000)}k lines`;
  return `${loc} lines`;
}

/** A website as GitHub stores it (often without a scheme), as a link, or null if it isn't one. */
export function websiteUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
