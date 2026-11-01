/**
 * Safety net, run by Vercel Cron: starts scans whose workflow never started,
 * and fails scans stuck far past their budget so no PR Check spins forever.
 */
import { timingSafeEqual } from "node:crypto";
import { strandedScans } from "@sandchest/db";
import { failScan } from "@/server/scans";
import { db } from "@/server/services";
import { startScan } from "@/server/start";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${secret}`);
  if (!secret || given.length !== wanted.length || !timingSafeEqual(given, wanted)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { unstarted, stuck } = await strandedScans(db());
  const results = await Promise.allSettled([
    ...unstarted.map((scan) => startScan(scan.id)),
    ...stuck.map((scan) => failScan(scan.id, "The scan stopped responding.")),
  ]);
  const failed = results.filter((r) => r.status === "rejected").length;
  return Response.json({ started: unstarted.length, failed: stuck.length, errors: failed });
}
