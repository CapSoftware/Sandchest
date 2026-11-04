/**
 * Scheduled deep scans. Run by the sweep every ten minutes: each repo whose
 * run is due is claimed (moved on to its next run) before anything else, so
 * two sweeps never both start it, and a failure never makes it run twice.
 */
import { claimScheduledRun, dueScheduledRepos, lastDeepScanHead, recordEvent, type DeepScanSchedule } from "@sandchest/db";
import { nextRun } from "@/lib/schedule";
import { requestDeepScan } from "./dig";
import { describeError } from "./log";
import { captureException } from "./sentry";
import { db, githubApp } from "./services";

/** Repos started per sweep, so one sweep stays short. The rest are still due at the next one. */
const PER_SWEEP = 25;

export async function runSchedules(now = new Date()): Promise<{ due: number; started: number }> {
  const due = await dueScheduledRepos(db(), now, PER_SWEEP);
  const outcomes = await Promise.all(due.map((repo) => runOne(repo, now)));
  return { due: due.length, started: outcomes.filter((outcome) => outcome === "ok").length };
}

async function runOne(repo: Awaited<ReturnType<typeof dueScheduledRepos>>[number], now: Date): Promise<string> {
  const schedule = repo.deepScanSchedule as Exclude<DeepScanSchedule, "off">;
  if (!(await claimScheduledRun(db(), repo.id, repo.nextDeepScanAt!, nextRun(schedule, repo.nextDeepScanAt!, now)))) return "claimed";
  let outcome: string;
  let scanId: string | undefined;
  try {
    const headSha = await githubApp().installation(repo.org.installationId!).branchSha(repo.fullName, repo.defaultBranch);
    // Nothing changed since the last deep scan: the same code would be paid for twice.
    if (headSha === (await lastDeepScanHead(db(), repo.id))) outcome = "unchanged";
    else {
      const result = await requestDeepScan(repo, "schedule", { headSha });
      outcome = result.ok ? "ok" : result.reason;
      scanId = result.scanId;
    }
  } catch (error) {
    // This run is skipped; the next one is already set.
    console.error(`Scheduled deep scan for repo ${repo.id} failed: ${describeError(error)}`);
    await captureException(error, { source: "schedule", tags: { repo_id: repo.id }, handled: true });
    outcome = "error";
  }
  await recordEvent(db(), { name: "scheduled_deep_scan", orgId: repo.orgId, props: { repo_id: repo.id, schedule, scan_id: scanId ?? null, outcome } }).catch(() => {});
  return outcome;
}
