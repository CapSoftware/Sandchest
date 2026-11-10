/**
 * What agents are shown: plain JSON in snake_case, with dashboard links a
 * person can open. Never internal costs or margins, never anyone else's data.
 */
import { DEEP_SCAN_TIERS, deepScanCredits } from "@sandchest/billing/costs";
import { isTrial, planById } from "@sandchest/billing/plans";
import type { DashboardRepo, FindingListItem, ScanListItem, SettingsOrg } from "@sandchest/db";
import type { BillView } from "@/lib/bill-view";
import { readHacker } from "@/lib/hacker";
import { installationSettingsUrl } from "@/lib/installation";
import { config } from "../config";
import type { UsageQuote } from "../usage-quote";

const iso = (date: Date | string | null | undefined) => (date ? new Date(date).toISOString() : null);

export function installUrl(): string | null {
  const slug = config().GITHUB_APP_SLUG;
  return slug ? `https://github.com/apps/${slug}/installations/new` : null;
}

export function planView(planId: string | null | undefined) {
  if (!planId) return null;
  const plan = planById(planId);
  return { id: planId, name: plan?.name ?? planId, price_usd_per_month: plan?.price ?? null, free_credits_only: isTrial(planId) };
}

interface StoredBilling {
  planId: string | null;
  credits: number;
}

/** An account as listed: who it is, the person's role, and its plan as last read. */
export function accountView(org: SettingsOrg, appUrl: string, billing: StoredBilling | null = org.billing) {
  const hacker = readHacker(org.settings.hacker);
  return {
    id: org.id,
    login: org.login,
    type: org.type === "Organization" ? "organization" : "user",
    admin: org.admin,
    plan: planView(billing?.planId),
    credits: billing ? billing.credits : null,
    recruited: !!org.settings.hacker,
    hacker: hacker.handle,
    repos: org.repos.map((repo) => ({ id: repo.id, full_name: repo.fullName, private: repo.private })),
    links: {
      settings: `${appUrl}/dashboard/settings`,
      choose_repositories_on_github: org.admin ? installationSettingsUrl(org) : null,
    },
  };
}

/**
 * What a deep scan of a repository would cost now, in credits. `usage`: the account's scans are billed from their
 * usage, so there is no fixed price: `up_to_credits` is the most one is charged (what it holds), and `fast` says
 * whether a fast one can be started and the most it is charged.
 */
export function deepScanPrice(repo: { loc: number | null }, usage?: UsageQuote) {
  const credits = repo.loc === null ? null : deepScanCredits(repo.loc);
  const tooLarge = repo.loc !== null && credits === undefined;
  if (usage) {
    return {
      credits: null,
      held_until_sized: null,
      too_large: tooLarge,
      up_to_credits: usage.hold,
      fast: usage.fast !== undefined ? { available: true, up_to_credits: usage.fast } : { available: false },
    };
  }
  return {
    credits: credits ?? null,
    /** Before recon has sized the repo, the largest price is held and only what it measures is charged. */
    held_until_sized: repo.loc === null ? DEEP_SCAN_TIERS.at(-1)!.credits : null,
    too_large: tooLarge,
  };
}

/** A scan's usage bill, as the scan page shows it: what each part used and came to in credits. Never costs or money. */
export function billApiView(bill: BillView) {
  const credits = (hundredths: number) => hundredths / 100;
  return {
    status: bill.status,
    lines: bill.groups.map((group) =>
      group.kind === "sandbox"
        ? { label: group.label, sandbox_seconds: group.seconds, credits: credits(group.credits) }
        : { label: group.label, calls: group.calls, input_tokens: group.inputTokens, output_tokens: group.outputTokens, credits: credits(group.credits) },
    ),
    usage: credits(bill.usage),
    carried_in: credits(bill.carriedIn),
    charged: bill.charged,
    carried_out: credits(bill.carriedOut),
    capped: bill.capped,
    fast: bill.fast,
    held: bill.held,
  };
}

export function repoView(repo: DashboardRepo, appUrl: string, usage?: UsageQuote) {
  return {
    id: repo.id,
    full_name: repo.fullName,
    private: repo.private,
    account: { id: repo.orgId, login: repo.orgLogin, admin: repo.orgAdmin },
    lines_of_code: repo.loc,
    open_findings: repo.open,
    last_scan: repo.lastScan ? { id: repo.lastScan.id, kind: repo.lastScan.kind, status: repo.lastScan.status, at: iso(repo.lastScan.at) } : null,
    last_deep_scan_at: iso(repo.lastDeepScanAt),
    running_deep_scan_id: repo.activeDeepScanId,
    pr_reviews_last_30_days: repo.reviews30d,
    /** When pull requests are reviewed: "auto" every push, "command" only on /sandchest review, "off" never. */
    pr_reviews: repo.prReviews,
    deep_scan_schedule: repo.deepScanSchedule,
    next_deep_scan_at: iso(repo.nextDeepScanAt),
    deep_scan: deepScanPrice(repo, usage),
    url: `${appUrl}/dashboard/repos/${repo.id}`,
  };
}

export function findingListView(finding: FindingListItem, appUrl: string) {
  return {
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    confidence: finding.confidence,
    status: finding.status,
    category: finding.category,
    repo: { id: finding.repoId, full_name: finding.repoFullName },
    location: finding.sink,
    found_by: finding.sourceKind === "pr_review" ? { kind: "pr_review", pr_number: finding.prNumber } : { kind: finding.sourceKind },
    last_seen_at: iso(finding.lastSeenAt),
    stale: finding.stale,
    url: `${appUrl}/dashboard/findings/${finding.id}`,
  };
}

export function scanListView(scan: ScanListItem, appUrl: string) {
  return {
    id: scan.id,
    kind: scan.kind,
    status: scan.status,
    pr_number: scan.prNumber,
    repo: { id: scan.repoId, full_name: scan.repoFullName },
    created_at: iso(scan.createdAt),
    finished_at: iso(scan.finishedAt),
    duration_ms: scan.durationMs,
    credits_charged: scan.credits,
    found: scan.found,
    url: `${appUrl}/dashboard/scans/${scan.id}`,
  };
}

export { iso };
