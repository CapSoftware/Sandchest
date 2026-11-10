/** Repositories and scans: what's installed, deep scans on demand, and following a scan live. */
import { canSeeScan, dashboardRepos, dashboardScans, DEEP_SCAN_SCHEDULES, feedSince, PR_REVIEW_MODES, scanBill, scanForUser, scanStatusOnly, threatModel, updateRepoSettings } from "@sandchest/db";
import { z } from "zod";
import { track } from "../../analytics";
import { BILLING_FROZEN } from "../../billing";
import { db } from "../../db";
import { describeError } from "../../log";
import { deepScanQuote, quotesByAccount } from "../../usage-quote";
import { billView } from "@/lib/bill-view";
import { PR_REVIEW_COST } from "@/lib/pricing";
import { firstRun } from "@/lib/schedule";
import { captureException } from "../../sentry";
import { ApiError, notFound } from "../errors";
import { AccountRef, flag, int, operation, RepoRef, Uuid } from "../operation";
import { resolveAccount, resolveRepo } from "../resolve";
import { billApiView, iso, repoView, scanListView } from "../views";

const DONE = new Set(["completed", "failed", "cancelled", "refused"]);
/** The longest a request waits for a scan to move on: under every proxy's idle timeout. */
const MAX_WAIT_S = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function scanView(userId: string, scanId: string, appUrl: string) {
  const row = await scanForUser(db(), userId, scanId);
  if (!row) throw notFound("scan");
  const { scan, repo, metrics } = row;
  const stats = (scan.stats ?? {}) as { loc?: number; checked?: number; fixed?: number };
  // Only a scan billed from its usage has a bill a customer sees; no other scan reads one, and its view has no `bill`.
  const stored = scan.pricing?.mode === "usage" ? await scanBill(db(), scan.id) : undefined;
  const bill = stored ? billView(stored) : undefined;
  return {
    id: scan.id,
    kind: scan.kind,
    status: scan.status,
    done: DONE.has(scan.status),
    trigger: scan.trigger,
    pr_number: scan.prNumber,
    commit: scan.headSha === "HEAD" ? null : scan.headSha,
    repo: { id: repo.id, full_name: repo.fullName },
    created_at: iso(scan.createdAt),
    started_at: iso(scan.startedAt),
    finished_at: iso(scan.finishedAt),
    duration_ms: metrics?.durationMs ?? (scan.startedAt && scan.finishedAt ? scan.finishedAt.getTime() - scan.startedAt.getTime() : null),
    credits: { held: scan.billing === "reserved" ? (scan.creditsReserved ?? 0) : 0, charged: scan.billing === "charged" ? scan.credits : 0 },
    lines_of_code: stats.loc ?? null,
    ...(scan.kind === "fix_check" && { findings_checked: stats.checked ?? null, findings_fixed: stats.fixed ?? null }),
    error: scan.status === "failed" || scan.status === "refused" ? scan.error : null,
    findings: row.findings.map((finding) => ({ id: finding.id, title: finding.title, severity: finding.severity, confidence: finding.confidence, status: finding.status, location: finding.sink ? { file: finding.sink.file, line: finding.sink.line } : null })),
    url: `${appUrl}/dashboard/scans/${scan.id}`,
    ...(bill && { bill: billApiView(bill) }),
  };
}

export const scanOps = [
  operation({
    name: "list_repos",
    title: "List repositories",
    description:
      "Repositories Sandchest can scan for this person (installed, with push access), most exposed first: open findings by severity, the latest scan, and what a deep scan costs now. Where an account's scans are billed by what they use, deep_scan has up_to_credits (the most one is charged) and fast (whether a fast scan can be started, and the most it is charged).",
    method: "GET",
    path: "/repos",
    input: z.object({ account: AccountRef.optional().describe("Only this account's repositories.") }),
    readOnly: true,
    async run(context, input) {
      const repos = await dashboardRepos(db(), context.principal.userId);
      const account = input.account ? await resolveAccount(context, input.account) : undefined;
      const quote = quotesByAccount();
      return { repos: repos.filter((repo) => !account || repo.orgId === account.id).map((repo) => repoView(repo, context.appUrl, quote(repo.orgLogin))) };
    },
  }),

  operation({
    name: "get_repo",
    title: "Get a repository",
    description: "One repository: open findings, deep scan price, recent scans, and its threat model (what recon mapped: entry points, trust boundaries, sensitive data; a summary, never source code).",
    method: "GET",
    path: "/repos/{repo}",
    input: z.object({ repo: RepoRef }),
    readOnly: true,
    async run(context, input) {
      const { repo } = await resolveRepo(context, input.repo);
      const [[row], scans, model] = await Promise.all([
        dashboardRepos(db(), context.principal.userId, { repoId: repo.id }),
        dashboardScans(db(), context.principal.userId, { repoId: repo.id }, 10),
        threatModel(db(), repo.id),
      ]);
      if (!row) throw notFound("repository");
      return {
        ...repoView(row, context.appUrl, deepScanQuote(row.orgLogin)),
        recent_scans: scans.map((scan) => scanListView(scan, context.appUrl)),
        threat_model: model ? { commit: model.commitSha, model: model.threatModel } : null,
      };
    },
  }),

  operation({
    name: "update_repo",
    title: "Change a repository's review settings",
    description:
      `Changes how a repository is reviewed (anyone who can push to it). pr_reviews: "auto" reviews every push to a pull request (each ${PR_REVIEW_COST}), "command" only when someone comments /sandchest review, "off" never. deep_scan_schedule: "off", "daily", "weekly" or "monthly" deep scans, each paid like a manual one and skipped when nothing changed.`,
    method: "PATCH",
    path: "/repos/{repo}",
    input: z.object({
      repo: RepoRef,
      pr_reviews: z.enum(PR_REVIEW_MODES).optional(),
      deep_scan_schedule: z.enum(DEEP_SCAN_SCHEDULES).optional(),
    }),
    idempotent: true,
    async run(context, input) {
      const { repo, org } = await resolveRepo(context, input.repo);
      if (!input.pr_reviews && !input.deep_scan_schedule) throw new ApiError(400, "nothing_to_change", "Pass pr_reviews or deep_scan_schedule.");
      const scheduleChanged = input.deep_scan_schedule !== undefined && input.deep_scan_schedule !== repo.deepScanSchedule;
      const patch = {
        ...(input.pr_reviews && { prReviews: input.pr_reviews }),
        ...(scheduleChanged && { deepScanSchedule: input.deep_scan_schedule, nextDeepScanAt: firstRun(input.deep_scan_schedule!, repo.lastDeepScanAt) }),
      };
      const ok = await updateRepoSettings(db(), context.principal.userId, repo.id, patch);
      await track("repo_settings_saved", {
        userId: context.principal.userId,
        orgId: org.id,
        props: { repo_id: repo.id, pr_reviews: input.pr_reviews ?? repo.prReviews, deep_scan_schedule: input.deep_scan_schedule ?? repo.deepScanSchedule, outcome: ok ? "ok" : "no_access", via: context.surface },
      });
      if (!ok) throw notFound("repository");
      const [row] = await dashboardRepos(db(), context.principal.userId, { repoId: repo.id });
      if (!row) throw notFound("repository");
      return repoView(row, context.appUrl, deepScanQuote(row.orgLogin));
    },
  }),

  operation({
    name: "start_deep_scan",
    title: "Start a deep scan",
    description:
      "Starts a deep scan of a whole repository: the hacker reads it end to end for exploitable vulnerabilities (usually 15 to 30 minutes for a large repository). The most it can cost is held now, and it is charged what it uses, never more. One at a time per repository. Then call get_scan with wait to follow it. Pass fast=true for a faster run where list_repos says deep_scan.fast is available (it costs more); it is refused anywhere else.",
    method: "POST",
    path: "/repos/{repo}/scans",
    status: 202,
    input: z.object({
      repo: RepoRef,
      fast: flag().optional().describe("Run it fast: a faster model, which costs about 3x on average. Only where list_repos says deep_scan.fast is available."),
    }),
    openWorld: true,
    async run(context, input) {
      const row = await resolveRepo(context, input.repo);
      const record = (outcome: string, extra: { credits?: number; scanId?: string } = {}) =>
        track("deep_scan_requested", {
          userId: context.principal.userId,
          orgId: row.org.id,
          props: { repo_id: row.repo.id, scan_again: !!row.repo.lastDeepScanAt, outcome, credits: extra.credits ?? null, scan_id: extra.scanId ?? null, via: context.surface },
        });
      // Loaded on demand: the workflow runtime stays out of every other request.
      const { requestDeepScan } = await import("../../dig");
      let result: Awaited<ReturnType<typeof requestDeepScan>>;
      try {
        result = await requestDeepScan({ ...row.repo, org: row.org }, "manual", input.fast === true ? { fast: true } : {});
      } catch (error) {
        console.error(`Agent deep scan failed: ${describeError(error)}`);
        await captureException(error, { source: "dig", tags: { via: context.surface }, handled: true });
        await record("error");
        throw new ApiError(502, "scan_not_started", "The deep scan couldn't start (GitHub or billing didn't answer). Nothing was charged; try again in a minute.");
      }
      if (!result.ok) {
        await record(result.reason, { credits: result.credits, scanId: result.scanId });
        const login = row.org.githubLogin;
        switch (result.reason) {
          case "running":
            throw new ApiError(409, "already_running", "A deep scan of this repository is already running. Follow it with get_scan.", { scan_id: result.scanId });
          case "not_installed":
            throw new ApiError(409, "not_installed", `Sandchest is no longer installed on ${row.repo.fullName}.`);
          case "too_large":
            throw new ApiError(422, "too_large", "This repository is over a million lines of code, too large for a deep scan.");
          case "no_plan":
            throw new ApiError(402, "no_plan", `${login} has no plan, so nothing scans. Call get_billing for ${login}: claim free credits or buy credits first.`, { account: login });
          case "out_of_credits":
            throw new ApiError(402, "out_of_credits", `${login} doesn't have enough credits${result.credits ? `: this deep scan needs ${result.credits}` : ""}. Call buy_credits for ${login}.`, { account: login, credits_needed: result.credits ?? null });
          case "frozen":
            throw new ApiError(503, "billing_frozen", BILLING_FROZEN);
          case "fast_unavailable":
            throw new ApiError(422, "fast_unavailable", `Fast deep scans aren't available for ${login}. Start it without fast.`, { account: login });
        }
      }
      await record("ok", { scanId: result.scanId });
      const message =
        result.heldUpTo !== undefined
          ? `Started, holding up to ${result.heldUpTo} ${result.heldUpTo === 1 ? "credit" : "credits"}: it's charged what it uses, never more. Call get_scan with wait=50 to follow it until it's done.`
          : "Started. Call get_scan with wait=50 to follow it until it's done.";
      return { scan: await scanView(context.principal.userId, result.scanId, context.appUrl), message };
    },
  }),

  operation({
    name: "list_scans",
    title: "List scans",
    description: "Scans the person can see, newest first: PR reviews, deep scans, recon and fix checks, with what each found and the credits it cost. Page with `before` (the last created_at you saw).",
    method: "GET",
    path: "/scans",
    input: z.object({
      repo: RepoRef.optional(),
      account: AccountRef.optional(),
      kind: z.enum(["recon", "pr_review", "deep", "fix_check"]).optional(),
      before: z.iso.datetime({ offset: true }).optional().describe("Only scans created before this time (ISO 8601), for the next page."),
      limit: int(1, 100).optional().describe("At most this many (default 25)."),
    }),
    readOnly: true,
    async run(context, input) {
      const [repo, account] = await Promise.all([input.repo ? resolveRepo(context, input.repo) : undefined, input.account ? resolveAccount(context, input.account) : undefined]);
      const limit = input.limit ?? 25;
      const scans = await dashboardScans(db(), context.principal.userId, { repoId: repo?.repo.id, orgId: account?.id, kind: input.kind, before: input.before ? new Date(input.before) : undefined }, limit);
      return { scans: scans.map((scan) => scanListView(scan, context.appUrl)), next_before: scans.length === limit ? iso(scans.at(-1)!.createdAt) : null };
    },
  }),

  operation({
    name: "get_scan",
    title: "Get a scan",
    description:
      "A scan's status and the findings it reported. Pass wait (seconds, up to 50) to hold the request until the scan finishes or the time is up, then call again while done is false. A deep scan of a large repository usually takes 15 to 30 minutes. A scan billed by what it used also has bill: what each part used and came to in credits (lines), its usage, what was carried in from earlier scans, charged, and carried to the next scan, whether it was capped at the credits held, whether it ran fast, and the credits held.",
    method: "GET",
    path: "/scans/{id}",
    input: z.object({ id: Uuid("scan"), wait: int(0, MAX_WAIT_S).optional().describe(`Seconds to wait for the scan to finish (0-${MAX_WAIT_S}).`) }),
    readOnly: true,
    async run(context, input) {
      let view = await scanView(context.principal.userId, input.id, context.appUrl);
      if (!view.done && input.wait) {
        const until = Date.now() + input.wait * 1_000;
        while (Date.now() < until) {
          await sleep(Math.min(2_000, until - Date.now()));
          const status = await scanStatusOnly(db(), input.id);
          if (!status || DONE.has(status)) break;
        }
        view = await scanView(context.principal.userId, input.id, context.appUrl);
      }
      return view;
    },
  }),

  operation({
    name: "get_scan_events",
    title: "Follow a scan's feed",
    description: "The scan's live feed: what the hacker is doing, line by line (stages, files read, findings as they survive verification). Pass `after` (the last seq you saw) for new lines only, and wait (seconds) to hold until there are some.",
    method: "GET",
    path: "/scans/{id}/events",
    input: z.object({
      id: Uuid("scan"),
      after: int(0, 2_147_483_647).optional().describe("Only lines after this seq."),
      wait: int(0, MAX_WAIT_S).optional().describe(`Seconds to wait for new lines (0-${MAX_WAIT_S}).`),
    }),
    readOnly: true,
    async run(context, input) {
      if (!(await canSeeScan(db(), context.principal.userId, input.id))) throw notFound("scan");
      const after = input.after ?? 0;
      const until = Date.now() + (input.wait ?? 0) * 1_000;
      let feed = await feedSince(db(), input.id, after);
      while (feed.events.length === 0 && !(feed.status && DONE.has(feed.status)) && Date.now() < until) {
        await sleep(Math.min(1_000, until - Date.now()));
        feed = await feedSince(db(), input.id, after);
      }
      return {
        status: feed.status,
        done: !!feed.status && DONE.has(feed.status),
        events: feed.events.map((event) => ({ seq: event.seq, type: event.type, message: event.message, at: iso(event.createdAt) })),
        next_after: feed.events.at(-1)?.seq ?? after,
      };
    },
  }),
];
