/**
 * First-party analytics, shared by the browser beacon and the server.
 *
 * Events hold opaque ids, counts and enums only. Paths keep their shape but
 * lose their ids (`/dashboard/findings/:id`); query strings are dropped,
 * except the standard `utm_*` campaign tags; referrers keep only their host;
 * clicks on links to other sites keep only the host. No text a person typed
 * or was shown is ever recorded.
 */

/** The anonymous visitor id: a random UUID in a first-party, HttpOnly cookie, set by the beacon. */
export const ANON_COOKIE = "sc_aid";
export const ANON_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

/** Where the browser sends events. Same origin, so ad blockers that block analytics hosts leave it alone. */
export const BEACON_PATH = "/api/e";

/** Events the browser may send. Everything else is recorded on the server, where it happened. */
export const BROWSER_EVENTS = ["page_view", "clicked", "step_viewed"] as const;
export type BrowserEvent = (typeof BROWSER_EVENTS)[number];

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
export type Utm = Partial<Record<(typeof UTM_KEYS)[number], string>>;

export const DEVICES = ["mobile", "tablet", "desktop"] as const;
export type Device = (typeof DEVICES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

/** A tag, slug or id as recorded: short, and only letters, digits and `._:/-`. */
const SAFE = /^[A-Za-z0-9._:/-]+$/;
export function safeToken(value: unknown, max = 64): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed && SAFE.test(trimmed) ? trimmed : undefined;
}

/**
 * A path as recorded: no query or fragment, and every segment that could be
 * an id (a UUID, a number, or anything long or unusual) replaced with `:id`.
 * Routes keep their shape, so they group, and nothing identifying survives.
 */
export function routeOf(path: string): string {
  const bare = path.split(/[?#]/, 1)[0] ?? "/";
  const segments = bare
    .split("/")
    .filter(Boolean)
    .slice(0, 8)
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return ":id";
      }
      if (UUID.test(decoded) || /^\d+$/.test(decoded) || decoded.length > 40 || !/^[a-z0-9._-]+$/.test(decoded)) return ":id";
      return decoded;
    });
  return `/${segments.join("/")}`;
}

/** The referring site's host, when it is another site. Nothing for direct visits or our own pages. */
export function referrerHost(referrer: string, ownHost: string): string | undefined {
  if (!referrer) return undefined;
  try {
    const host = new URL(referrer).hostname.toLowerCase();
    return host && host !== ownHost.toLowerCase() ? safeToken(host, 100) : undefined;
  } catch {
    return undefined;
  }
}

/** The campaign tags in a query string, each a short safe token. */
export function utmOf(search: string): Utm {
  const params = new URLSearchParams(search);
  const utm: Utm = {};
  for (const key of UTM_KEYS) {
    const value = safeToken(params.get(key));
    if (value) utm[key] = value;
  }
  return utm;
}

/**
 * What a click was on: the element's `data-track` id if it has one, else an
 * internal link's route, else an external link's host. Buttons without a
 * `data-track` id are not recorded: their text could name a person or repo.
 */
export function clickTarget(element: { track?: string | null; href?: string | null }, ownOrigin: string): string | undefined {
  const tracked = safeToken(element.track);
  if (tracked) return tracked;
  if (!element.href) return undefined;
  try {
    const url = new URL(element.href, ownOrigin);
    if (url.origin === ownOrigin) return routeOf(url.pathname);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return safeToken(url.hostname.toLowerCase(), 100);
  } catch {
    return undefined;
  }
}

export function deviceOf(width: number): Device {
  return width < 640 ? "mobile" : width < 1024 ? "tablet" : "desktop";
}

/** Crawlers, link previews and headless browsers: their page views are not people. */
export const BOT_AGENT = /bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit|embedly|quora|pinterest|vercel-screenshot|python|curl|wget|httpclient|okhttp|go-http/i;
