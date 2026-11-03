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

/** Sends an event. `unloading`: the page is going away, so it goes by `sendBeacon`, which the browser finishes afterwards. */
function send(event: Record<string, unknown>, unloading = false): void {
  try {
    const body = JSON.stringify({ path: location.pathname, ...event, hint: hint() });
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

function pauseVisible(): void {
  if (visible.since !== null) visible.ms += performance.now() - visible.since;
  visible.since = null;
}

/** Records how long the page was looked at, once, when it is left (navigation, tab closed or hidden). */
function leave(): void {
  pauseVisible();
  if (visible.path && visible.ms > 0) send({ name: "page_left", path: visible.path, visible_ms: Math.round(visible.ms) }, true);
  visible.ms = 0;
}

function onVisibility(): void {
  if (document.visibilityState === "hidden") leave();
  else if (visible.since === null) visible.since = performance.now();
}

function onClick(event: MouseEvent): void {
  const element = event.target instanceof Element ? event.target.closest("a[href], [data-track]") : null;
  if (!element) return;
  const target = clickTarget({ track: element.getAttribute("data-track"), href: element.getAttribute("href") }, location.origin);
  if (target) send({ name: "clicked", target });
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
    if (!first) leave();
    lastView = view;
    startVisible(location.pathname);
    // Where they came from matters only for the page they landed on. The server keeps only known parameters.
    send({
      name: "page_view",
      referrer: first ? referrerHost(document.referrer, location.hostname) : undefined,
      search: location.search,
      device: deviceOf(window.innerWidth),
    });
  }, [pathname, search]);

  useEffect(() => {
    document.addEventListener("click", onClick, { capture: true });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", leave);
    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", leave);
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
