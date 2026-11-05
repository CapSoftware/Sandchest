/**
 * The dashboard's first deep scan: once an account has joined, nothing scans a whole repository until the
 * person chooses one and presses Start. This decides when that choice is offered, what each repository
 * would cost, and which one is suggested.
 */
import type { DashboardRepo } from "@sandchest/db";
import { DEEP_SCAN_TIERS } from "@sandchest/billing/costs";
import { digState } from "./dig-state";
import { readHacker, type HackerProfile } from "./hacker";

export interface FirstScanRepo {
  id: string;
  fullName: string;
  private: boolean;
  loc: number | null;
  orgId: string;
  /** Credits a deep scan takes, or the most it can (held, then charged what it measures) before recon sizes it. */
  credits: number;
  /** Recon hasn't sized it yet: `credits` is what's held, not the price. */
  unsized: boolean;
}

export interface FirstScanOrg {
  id: string;
  login: string;
  hacker: Pick<HackerProfile, "handle" | "hoodie" | "phosphor">;
  /** Credits left, or null when billing is off. */
  credits: number | null;
  /** Whether the person can buy credits for it. */
  admin: boolean;
}

export interface FirstScan {
  repos: FirstScanRepo[];
  orgs: FirstScanOrg[];
  /** The one suggested: the busiest, then the largest. */
  suggested: string;
}

/**
 * What to offer, or undefined once anything has been deep scanned (or is being), or when no account the
 * person can see has joined. `plans` is undefined per org when billing is off.
 */
export function firstScan(
  repos: DashboardRepo[],
  plans: Map<string, { planId: string | null; credits: number } | undefined>,
  hackers: Array<{ orgId: string; hacker: unknown }>,
): FirstScan | undefined {
  if (repos.some((repo) => repo.lastDeepScanAt || repo.activeDeepScanId)) return undefined;
  const joined = (orgId: string) => {
    const plan = plans.get(orgId);
    return plan === undefined || plan.planId !== null;
  };
  const offered = repos
    .filter((repo) => joined(repo.orgId))
    .flatMap((repo): FirstScanRepo[] => {
      const state = digState({ loc: repo.loc, activeDeepScanId: null });
      if (state.state !== "ready") return [];
      return [{ id: repo.id, fullName: repo.fullName, private: repo.private, loc: repo.loc, orgId: repo.orgId, credits: state.credits ?? DEEP_SCAN_TIERS.at(-1)!.credits, unsized: state.credits === undefined }];
    });
  if (offered.length === 0) return undefined;
  const busy = new Map(repos.map((repo) => [repo.id, repo.reviews30d]));
  const ranked = [...offered].sort((a, b) => busy.get(b.id)! - busy.get(a.id)! || (b.loc ?? -1) - (a.loc ?? -1) || a.fullName.localeCompare(b.fullName));
  const orgs = [...new Map(offered.map((repo) => [repo.orgId, repos.find((r) => r.orgId === repo.orgId)!])).values()].map((repo) => ({
    id: repo.orgId,
    login: repo.orgLogin,
    hacker: readHacker(hackers.find((h) => h.orgId === repo.orgId)?.hacker),
    credits: plans.get(repo.orgId)?.credits ?? null,
    admin: repo.orgAdmin,
  }));
  return { repos: ranked, orgs, suggested: ranked[0]!.id };
}
