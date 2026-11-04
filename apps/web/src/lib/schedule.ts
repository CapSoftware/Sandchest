/**
 * When a repository's scheduled deep scans run. A schedule keeps the repo
 * scanned at least that often: the first run is due one interval after the
 * last deep scan (now, if that has passed or there was none), and each run
 * sets the next one interval later.
 */
import type { DeepScanSchedule } from "@sandchest/db";

/** The interval after `from`. Monthly keeps the day of the month where it can (31 Jan → 28 Feb). */
export function addInterval(schedule: Exclude<DeepScanSchedule, "off">, from: Date): Date {
  const next = new Date(from);
  if (schedule === "daily") next.setUTCDate(next.getUTCDate() + 1);
  else if (schedule === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  else {
    const day = next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(day, last));
  }
  return next;
}

/** When the first run of a newly chosen schedule is due. Null for off. */
export function firstRun(schedule: DeepScanSchedule, lastDeepScanAt: Date | null, now = new Date()): Date | null {
  if (schedule === "off") return null;
  if (!lastDeepScanAt) return now;
  const due = addInterval(schedule, lastDeepScanAt);
  return due > now ? due : now;
}

/**
 * The run after one that came due at `due`. It keeps the schedule's rhythm
 * (the same time of day), unless runs were missed, when it counts on from now.
 */
export function nextRun(schedule: Exclude<DeepScanSchedule, "off">, due: Date, now = new Date()): Date {
  const next = addInterval(schedule, due);
  return next > now ? next : addInterval(schedule, now);
}
