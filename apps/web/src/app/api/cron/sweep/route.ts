/**
 * Safety net, run by Vercel Cron: starts scans whose workflow never started,
 * fails scans stuck far past their budget so no PR Check spins forever, and
 * settles credits a finished scan still holds (charging a completed scan whose
 * charge failed, releasing the rest). Also clears out expired agent codes and tokens.
 */
import { timingSafeEqual } from "node:crypto";
import { deleteExpiredAgentGrants, strandedScans, unsettledScans } from "@sandchest/db";
import { settleScan } from "@/server/billing";
import { failScan } from "@/server/scans";
import { db } from "@/server/services";
import { startScan } from "@/server/start";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${secret}`);
  if (!secret || given.length !== wanted.length || !timingSafeEqual(given, wanted)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const [{ unstarted, stuck }, unsettled] = await Promise.all([strandedScans(db()), unsettledScans(db())]);
  const results = await Promise.allSettled([
    ...unstarted.map((scan) => startScan(scan.id)),
    ...stuck.map((scan) => failScan(scan.id, "The scan stopped responding.")),
    ...unsettled.map((scan) => settleScan(scan, scan.status === "completed" ? "charge" : "release", scan.credits)),
    // Device codes, OAuth codes and tokens no one can use any more.
    deleteExpiredAgentGrants(db()),
  ]);
  const failed = results.filter((r) => r.status === "rejected").length;
  return Response.json({ started: unstarted.length, failed: stuck.length, settled: unsettled.length, errors: failed });
}
