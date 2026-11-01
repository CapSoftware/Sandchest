/**
 * Reading better-auth's session cookie without loading better-auth, so the
 * proxy can check a session cheaply.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { SESSION_COOKIES } from "@/lib/app-routes";

/** How long a session lasts, and how often its expiry is pushed back while it is used (better-auth's defaults, set explicitly). */
export const SESSION_EXPIRES_IN_S = 7 * 24 * 60 * 60;
export const SESSION_UPDATE_AGE_S = 24 * 60 * 60;

/**
 * Whether a session is due to be extended: better-auth's own rule. Pages read
 * sessions themselves and cannot set cookies, so the dashboard asks
 * better-auth's get-session endpoint to do it from the browser when due.
 */
export function sessionRefreshDue(expiresAt: Date, now = Date.now()): boolean {
  return expiresAt.getTime() - SESSION_EXPIRES_IN_S * 1000 + SESSION_UPDATE_AGE_S * 1000 <= now;
}

/** better-auth's session cookie, with the `__Secure-` prefix it uses over HTTPS. */
export function sessionCookieName(): string {
  return SESSION_COOKIES[config().SANDCHEST_APP_URL.startsWith("https://") ? 0 : 1];
}

/**
 * The session token in a signed session cookie (`<token>.<HMAC-SHA256 in
 * base64>`, better-auth's format), or undefined if the signature is wrong.
 * Verified with BETTER_AUTH_SECRET only: better-auth's BETTER_AUTH_SECRETS
 * rotation list is not supported, so don't set it.
 */
export function verifiedSessionToken(cookie: string | undefined, secret: string | undefined): string | undefined {
  if (!cookie || !secret) return undefined;
  let value = cookie;
  if (cookie.includes("%")) {
    // A malformed escape is a bad cookie, not a server error.
    try {
      value = decodeURIComponent(cookie);
    } catch {
      return undefined;
    }
  }
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const token = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(createHmac("sha256", secret).update(token).digest("base64"));
  return given.length === expected.length && timingSafeEqual(given, expected) ? token : undefined;
}
