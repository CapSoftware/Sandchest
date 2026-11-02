/** Sandchest's running totals (lines scanned, scans running), for the live counter. Public: totals only. */
import { liveStats, STATS_TTL_S } from "@/server/stats";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    // One cached total for everyone: the CDN keeps it for ten minutes and serves the last one while it refreshes,
    // so the database is asked about once every ten minutes however many people are watching.
    return Response.json(await liveStats(), {
      headers: { "cache-control": `public, max-age=60, s-maxage=${STATS_TTL_S}, stale-while-revalidate=${STATS_TTL_S * 6}` },
    });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
