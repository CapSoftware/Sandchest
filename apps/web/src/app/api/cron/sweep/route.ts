/**
 * Safety net, run by Vercel Cron: starts scans whose workflow never started,
 * fails scans whose start was lost halfway and scans whose workflow has
 * stopped, so no PR Check spins forever and no Dig stays blocked, and settles
 * credits a finished scan still holds (charging a completed scan whose charge
 * failed, releasing the rest). Also starts scheduled deep scans that are due,
 * clears out expired agent codes and tokens, and keeps the CVE directory
 * current (see `sweepCves`).
 */
import { timingSafeEqual } from "node:crypto";
import { deleteExpiredAgentGrants, strandedScans, unsettledScans, type Scan } from "@sandchest/db";
import { settleScan } from "@/server/billing";
import { sweepCves } from "@/server/cves";
import { failScan } from "@/server/scans";
import { db } from "@/server/services";
import { runSchedules } from "@/server/schedule";
import { startInventory, startScan, workflowRunning } from "@/server/start";

export const dynamic = "force-dynamic";

/**
 * Past this, a scan is failed even if its workflow says it is still running.
 * Two execute attempts, each cut off with its sandbox at the scan budget plus
 * five minutes, and a publish take well under an hour; this stays well inside
 * the six hours Autumn holds a reservation, so a scan that runs long is still
 * charged when it finishes.
 */
const RUN_LIMIT_MS = 2 * 3_600_000;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${secret}`);
  if (!secret || given.length !== wanted.length || !timingSafeEqual(given, wanted)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const [{ unstarted, unfinishedStarts, stuck }, unsettled] = await Promise.all([strandedScans(db()), unsettledScans(db())]);
  const now = Date.now();
  const schedules = runSchedules(new Date(now));
  // New and changed advisories from OSV, inventories to read, and inventories due their daily full check.
  const cves = sweepCves(startInventory, new Date(now));
  const failing = [...unfinishedStarts.map((scan) => failScan(scan.id, "The scan could not start.").then(() => true)), ...stuck.map((scan) => failIfStopped(scan, now))];
  const results = await Promise.allSettled([
    ...unstarted.map((scan) => startScan(scan.id)),
    ...failing,
    ...unsettled.map((scan) => settleScan(scan, scan.status === "completed" ? "charge" : "release", scan.credits)),
    // Device codes, OAuth codes and tokens no one can use any more.
    deleteExpiredAgentGrants(db()),
    schedules,
    cves,
  ]);
  const errors = results.filter((r) => r.status === "rejected").length;
  const failed = (await Promise.allSettled(failing)).filter((r) => r.status === "fulfilled" && r.value).length;
  const scheduled = await schedules.then((result) => result.started).catch(() => 0);
  const advisories = await cves.catch(() => null);
  return Response.json({ started: unstarted.length, failed, settled: unsettled.length, scheduled, errors, advisories });
}

/**
 * Fails a scan past its budget only once its workflow has stopped: a slow
 * scan (an execute step retried) can run past half an hour, and failing it
 * then would give its credits back while it goes on to finish.
 */
async function failIfStopped(scan: Scan, now: number): Promise<boolean> {
  if (now - (scan.startedAt?.getTime() ?? 0) < RUN_LIMIT_MS && (await workflowRunning(scan.workflowRunId))) return false;
  await failScan(scan.id, "The scan stopped responding.");
  return true;
}
