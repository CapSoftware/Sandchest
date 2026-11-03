/**
 * Server-side analytics: records what people did, where it happened, in the
 * first-party `events` table (see packages/db/ANALYTICS.md). Recording runs
 * after the response, on its own connection (`analyticsDb`), and never fails
 * or slows the action that called it.
 */
import { recordEvents, type AnalyticsEvent, type EventName, type EventProps } from "@sandchest/db";
import { cookies } from "next/headers";
import { after } from "next/server";
import { ANON_COOKIE } from "@/lib/analytics";
import { isUuid } from "@/lib/uuid";
import { analyticsDb } from "./db";

/** Runs a task after the response when there is one, else at once in the background. Never throws. */
export function later(task: () => Promise<unknown>): void {
  const run = () => task().catch(() => {});
  try {
    after(run);
  } catch {
    // Outside a request (tests, scripts): nothing to wait for.
    void run();
  }
}

/** Records events after the response, on the analytics connection. */
export function recordLater(events: AnalyticsEvent[], options?: { ignoreDuplicates?: boolean }): void {
  if (events.length > 0) later(() => recordEvents(analyticsDb(), events, options));
}

/** The browser's anonymous id from its cookie, when there is a request with one. */
export async function anonId(): Promise<string | null> {
  try {
    const value = (await cookies()).get(ANON_COOKIE)?.value;
    return isUuid(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Records an event for the current request's person and browser. `props`
 * must hold only opaque ids, counts and enums: never names, emails, repo
 * names, code or finding text.
 */
export async function track(name: EventName, event: { userId?: string | null; orgId?: string | null; props?: EventProps } = {}): Promise<void> {
  recordLater([{ name, userId: event.userId, orgId: event.orgId, anonId: await anonId(), props: event.props }]);
}
