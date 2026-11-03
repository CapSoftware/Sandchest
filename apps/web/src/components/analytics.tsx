"use client";
/**
 * Page views and clicks, sent to our own beacon (`/api/e`), plus Vercel's
 * cookieless Web Analytics and Speed Insights when the site runs on Vercel.
 * See `lib/analytics` for what is recorded and what never is.
 */
import { Analytics as VercelAnalytics, type BeforeSendEvent } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { BEACON_PATH, clickTarget, deviceOf, referrerHost, routeOf, UTM_KEYS } from "@/lib/analytics";

const HINT_KEY = "sc_aid_hint";

/** This tab's id, so the first page's events share one anonymous id before the cookie is set. */
function hint(): string | undefined {
  try {
    let value = sessionStorage.getItem(HINT_KEY);
    if (!value) {
      value = crypto.randomUUID();
      sessionStorage.setItem(HINT_KEY, value);
    }
    return value;
  } catch {
    return undefined;
  }
}

/** Events waiting to go: a page's clicks and steps travel together, so a page view costs about one request. */
const queue: Record<string, unknown>[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
/** Queued events wait at most this long, and a queue this long goes at once. */
const FLUSH_MS = 5_000;
const FLUSH_AT = 20;

/**
 * Sends everything queued in one request. `unloading`: the page is going away,
 * so it goes by `sendBeacon`, which the browser finishes afterwards.
 */
function flush(unloading = false): void {
  clearTimeout(timer);
  timer = undefined;
  if (queue.length === 0) return;
  try {
    const body = JSON.stringify({ events: queue.splice(0), hint: hint() });
    // Plain text, so the beacon is a simple request; the server reads the body as JSON whatever its type.
    if (unloading && navigator.sendBeacon?.(BEACON_PATH, new Blob([body], { type: "text/plain" }))) return;
    void fetch(BEACON_PATH, {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      // Survives the page unloading, as when a click leaves for GitHub.
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Analytics never breaks a page.
  }
}

/** Queues an event; `now` sends the queue at once. */
function send(event: Record<string, unknown>, now = false): void {
  queue.push({ path: location.pathname, ...event });
  if (now || queue.length >= FLUSH_AT) flush();
  else timer ??= setTimeout(() => flush(), FLUSH_MS);
}

/** Records that a step of a multi-step flow was shown. */
export function trackStep(flow: "recruit", step: string): void {
  send({ name: "step_viewed", flow, step });
}

/** The page being viewed (path and query), so one navigation is one view (React's development double effects included). */
let lastView: string | null = null;

/** How long the current page has been visible, for `page_left`. */
const visible = { path: "", ms: 0, since: 0 as number | null };

function startVisible(path: string): void {
  visible.path = path;
  visible.ms = 0;
  visible.since = document.visibilityState === "visible" ? performance.now() : null;
}

/** Queues the time the page has been on screen since the last report, and starts counting again if it still is. */
function reportVisible(): void {
  if (visible.since !== null) visible.ms += performance.now() - visible.since;
  visible.since = document.visibilityState === "visible" ? performance.now() : null;
  if (visible.path && visible.ms >= 1) send({ name: "page_left", path: visible.path, visible_ms: Math.round(visible.ms) });
  visible.ms = 0;
}

/** Hidden (tab switched or closed, page unloading): report the time and send everything now. */
function onVisibility(): void {
  if (document.visibilityState === "hidden") {
    reportVisible();
    flush(true);
  } else if (visible.since === null) visible.since = performance.now();
}

function onPageHide(): void {
  reportVisible();
  flush(true);
}

function onClick(event: MouseEvent): void {
  const element = event.target instanceof Element ? event.target.closest("a[href], [data-track]") : null;
  if (!element) return;
  const href = element.getAttribute("href");
  const target = clickTarget({ track: element.getAttribute("data-track"), href }, location.origin);
  if (!target) return;
  send({ name: "clicked", target });
  // A link usually leaves the page: send now, with the time spent so far, while the request can still go.
  if (href && element.tagName === "A") {
    reportVisible();
    flush();
  }
}

/** Vercel gets the same reduced URL we record: the route, and campaign tags only. */
function reduceUrl<T extends { url: string }>(event: T): T {
  try {
    const url = new URL(event.url);
    const kept = new URLSearchParams();
    for (const key of UTM_KEYS) {
      const value = url.searchParams.get(key);
      if (value) kept.set(key, value);
    }
    const query = kept.toString();
    return { ...event, url: `${url.origin}${routeOf(url.pathname)}${query ? `?${query}` : ""}` };
  } catch {
    return event;
  }
}

/** The browser half of first-party analytics. Reads the query string, so it sits in its own Suspense boundary. */
function Tracker() {
  const pathname = usePathname();
  const search = useSearchParams().toString();

  useEffect(() => {
    const view = `${location.pathname}${location.search}`;
    if (lastView === view) return;
    const first = lastView === null;
    if (!first) reportVisible();
    lastView = view;
    startVisible(location.pathname);
    // Where they came from matters only for the page they landed on. The server keeps only known parameters.
    // Sent at once, with whatever the last page queued: about one request per page.
    send(
      {
        name: "page_view",
        referrer: first ? referrerHost(document.referrer, location.hostname) : undefined,
        search: location.search,
        device: deviceOf(window.innerWidth),
      },
      true,
    );
  }, [pathname, search]);

  useEffect(() => {
    document.addEventListener("click", onClick, { capture: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  return null;
}

export function Analytics({ vercel }: { vercel: boolean }) {
  return (
    <>
      <Suspense fallback={null}>
        <Tracker />
      </Suspense>
      {vercel && (
        <>
          <VercelAnalytics beforeSend={(event: BeforeSendEvent) => reduceUrl(event)} />
          <SpeedInsights beforeSend={(event) => reduceUrl(event)} />
        </>
      )}
    </>
  );
}
