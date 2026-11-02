/**
 * Sandchest's running totals, for the counter shown where people decide to
 * pay: lines read across every completed scan, and scans running right now.
 * Totals only, nothing about any org. One copy for everyone, read from the
 * database at most every ten minutes.
 */
import { linesScanned } from "@sandchest/db";
import { unstable_cache } from "next/cache";
import { db } from "./db";

export interface LiveStats {
  lines: number;
  running: number;
}

/** How long one reading of the totals is shown to everyone, in seconds. The counter climbs toward it in that time. */
export const STATS_TTL_S = 600;

// Next's data cache, so every server instance (and the page and /api/stats) shares the one reading.
export const liveStats: () => Promise<LiveStats> = unstable_cache(() => linesScanned(db()), ["live-stats-v2"], { revalidate: STATS_TTL_S });
