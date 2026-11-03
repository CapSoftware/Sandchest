"use client";
/**
 * Page views and clicks, sent to our own beacon (`/api/e`), plus Vercel's
 * cookieless Web Analytics and Speed Insights when the site runs on Vercel.
 * See `lib/analytics` for what is recorded and what never is.
 */
import { Analytics as VercelAnalytics, type BeforeSendEvent } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { BEACON_PATH, clickTarget, deviceOf, referrerHost, routeOf, utmOf, UTM_KEYS } from "@/lib/analytics";

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

function send(event: Record<string, unknown>): void {
  try {
    void fetch(BEACON_PATH, {
      method: "POST",
      body: JSON.stringify({ ...event, path: location.pathname, hint: hint() }),
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

/** The last path recorded, so one navigation is one view (React's development double effects included). */
let lastPath: string | null = null;

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

export function Analytics({ vercel }: { vercel: boolean }) {
  const pathname = usePathname();

  useEffect(() => {
    if (lastPath === location.pathname) return;
    const first = lastPath === null;
    lastPath = location.pathname;
    // Where they came from matters only for the page they landed on.
    send({
      name: "page_view",
      referrer: first ? referrerHost(document.referrer, location.hostname) : undefined,
      utm: utmOf(location.search),
      device: deviceOf(window.innerWidth),
    });
  }, [pathname]);

  useEffect(() => {
    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, []);

  if (!vercel) return null;
  return (
    <>
      <VercelAnalytics beforeSend={(event: BeforeSendEvent) => reduceUrl(event)} />
      <SpeedInsights beforeSend={(event) => reduceUrl(event)} />
    </>
  );
}
