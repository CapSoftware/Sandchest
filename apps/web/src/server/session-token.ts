/**
 * Reading better-auth's session cookie without loading better-auth, so the
 * proxy can check a session cheaply.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";

/** better-auth's session cookie, with the `__Secure-` prefix it uses over HTTPS. */
export function sessionCookieName(): string {
  return config().SANDCHEST_APP_URL.startsWith("https://") ? "__Secure-better-auth.session_token" : "better-auth.session_token";
}

/**
 * The session token in a signed session cookie (`<token>.<HMAC-SHA256 in
 * base64>`, better-auth's format), or undefined if the signature is wrong.
 */
export function verifiedSessionToken(cookie: string | undefined, secret: string | undefined): string | undefined {
  if (!cookie || !secret) return undefined;
  const value = cookie.includes("%") ? decodeURIComponent(cookie) : cookie;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const token = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(createHmac("sha256", secret).update(token).digest("base64"));
  return given.length === expected.length && timingSafeEqual(given, expected) ? token : undefined;
}
