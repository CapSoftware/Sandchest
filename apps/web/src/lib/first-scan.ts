/**
 * Choosing a repository to deep scan from the dashboard: the launcher behind the Deep scan key, and the panel
 * that offers the first one. Nothing scans a whole repository until the person chooses one and presses Start.
 * This decides which repositories are offered, what each would cost, and which one is suggested.
 */
import type { DashboardRepo } from "@sandchest/db";
import { DEEP_SCAN_TIERS } from "@sandchest/billing/costs";
import { digState } from "./dig-state";
import { timeAgo } from "./format";
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
  /** Billed from its usage: `credits` is the most it holds, whatever its size, and it's charged what it uses. Absent otherwise. */
  usage?: true;
  /** When it was last deep scanned, as said after "scanned": "3 days ago", "last week". Null when it never was. */
  scanned: string | null;
  /** A deep scan of it is running now, so it can't be chosen. Absent otherwise. */
  running?: true;
  /** Credits its last deep scan was charged from its usage, when it was. */
  lastCost?: number;
}

export interface FirstScanOrg {
  id: string;
  login: string;
  hacker: Pick<HackerProfile, "handle" | "hoodie" | "phosphor">;
  /** Credits left, or null when billing is off. */
  credits: number | null;
  /** Whether the person can add funds for it. */
  admin: boolean;
}

export interface FirstScan {
  repos: FirstScanRepo[];
  orgs: FirstScanOrg[];
  /** The one suggested: the busiest, then the largest, of those not being scanned now. */
  suggested: string;
}

type Plans = Map<string, { planId: string | null; credits: number; usage?: { hold: number } } | undefined>;

/**
 * The repositories a deep scan can be started on, or undefined when there is none to choose: every repository
 * of an account that has joined, bar the ones too large to scan, with the ones being scanned now listed but not
 * choosable. `plans` is undefined per org when billing is off. `charges`: what each repository's last deep scan
 * was charged from its usage, by repository id.
 */
export function scanChoices(
  repos: DashboardRepo[],
  plans: Plans,
  hackers: Array<{ orgId: string; hacker: unknown }>,
  options: { charges?: ReadonlyMap<string, number>; now?: number } = {},
): FirstScan | undefined {
  const joined = (orgId: string) => {
    const plan = plans.get(orgId);
    return plan === undefined || plan.planId !== null;
  };
  const offered = repos
    .filter((repo) => joined(repo.orgId))
    .flatMap((repo): FirstScanRepo[] => {
      const state = digState({ loc: repo.loc, activeDeepScanId: null });
      if (state.state !== "ready") return [];
      const usage = plans.get(repo.orgId)?.usage;
      const lastCost = options.charges?.get(repo.id);
      return [
        {
          id: repo.id,
          fullName: repo.fullName,
          private: repo.private,
          loc: repo.loc,
          orgId: repo.orgId,
          credits: usage ? usage.hold : (state.credits ?? DEEP_SCAN_TIERS.at(-1)!.credits),
          unsized: state.credits === undefined,
          ...(usage && { usage: true as const }),
          scanned: repo.lastDeepScanAt ? timeAgo(repo.lastDeepScanAt, options.now, true) : null,
          ...(repo.activeDeepScanId && { running: true as const }),
          ...(lastCost !== undefined && { lastCost }),
        },
      ];
    });
  const busy = new Map(repos.map((repo) => [repo.id, repo.reviews30d]));
  const ranked = [...offered].sort((a, b) => busy.get(b.id)! - busy.get(a.id)! || (b.loc ?? -1) - (a.loc ?? -1) || a.fullName.localeCompare(b.fullName));
  const suggested = ranked.find((repo) => !repo.running);
  if (!suggested) return undefined;
  const orgs = [...new Map(offered.map((repo) => [repo.orgId, repos.find((r) => r.orgId === repo.orgId)!])).values()].map((repo) => ({
    id: repo.orgId,
    login: repo.orgLogin,
    hacker: readHacker(hackers.find((h) => h.orgId === repo.orgId)?.hacker),
    credits: plans.get(repo.orgId)?.credits ?? null,
    admin: repo.orgAdmin,
  }));
  return { repos: ranked, orgs, suggested: suggested.id };
}

/**
 * The first deep scan: what to offer, or undefined once anything has been deep scanned (or is being), or when no
 * account the person can see has joined.
 */
export function firstScan(repos: DashboardRepo[], plans: Plans, hackers: Array<{ orgId: string; hacker: unknown }>): FirstScan | undefined {
  if (repos.some((repo) => repo.lastDeepScanAt || repo.activeDeepScanId)) return undefined;
  return scanChoices(repos, plans, hackers);
}
