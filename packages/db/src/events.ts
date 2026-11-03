/**
 * Recording first-party analytics events (see ../ANALYTICS.md). Writes are
 * bounded and give way to the app's own queries.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./client";
import { events, type EventName, type EventProps } from "./schema";

export interface AnalyticsEvent {
  name: EventName;
  userId?: string | null;
  orgId?: string | null;
  /** The browser's anonymous id, when the event came from one. */
  anonId?: string | null;
  props?: EventProps;
}

/**
 * Analytics writes give way to everything else: a write that would wait on a
 * lock for more than LOCK_MS, or run for more than STATEMENT_MS, is dropped
 * rather than hold a connection the app needs. Set per transaction, so it
 * works behind a transaction-mode pooler and never leaks to other queries.
 */
const STATEMENT_MS = 1_000;
const LOCK_MS = 200;

/** At most this many events in one insert (the beacon sends a page's worth at a time). */
export const MAX_EVENTS_PER_WRITE = 50;

/**
 * Records analytics events in one bounded insert. `props` must hold only
 * opaque ids, counts and enums. `ignoreDuplicates` skips events a unique index
 * already has (daily visits, browser links).
 */
export async function recordEvents(database: Db, list: AnalyticsEvent[], options: { ignoreDuplicates?: boolean } = {}): Promise<void> {
  const rows = list.slice(0, MAX_EVENTS_PER_WRITE).map((event) => ({
    name: event.name,
    userId: event.userId ?? null,
    orgId: event.orgId ?? null,
    anonId: event.anonId ?? null,
    props: event.props ?? {},
  }));
  if (rows.length === 0) return;
  await database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', ${String(STATEMENT_MS)}, true), set_config('lock_timeout', ${String(LOCK_MS)}, true)`);
    const insert = tx.insert(events).values(rows);
    await (options.ignoreDuplicates ? insert.onConflictDoNothing() : insert);
  });
}

/** Records one analytics event (see `recordEvents`). */
export async function recordEvent(database: Db, event: AnalyticsEvent): Promise<void> {
  await recordEvents(database, [event]);
}

/** Records that someone opened the dashboard today (UTC). A second call the same day changes nothing. */
export async function recordDailyVisit(database: Db, userId: string, anonId?: string | null): Promise<void> {
  await recordEvents(database, [{ name: "dashboard_visit", userId, anonId }], { ignoreDuplicates: true });
}

/** Ties a browser to the signed-in person using it. Recorded once per browser and person. */
export async function recordIdentified(database: Db, userId: string, anonId: string): Promise<void> {
  await recordEvents(database, [{ name: "identified", userId, anonId }], { ignoreDuplicates: true });
}
