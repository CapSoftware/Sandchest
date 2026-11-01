/**
 * First-run setup: creating this deployment's GitHub App from a manifest
 * (SPEC §18). Only available while no App is configured (`GITHUB_APP_ID`
 * unset), and only to whoever holds the setup token.
 *
 * The token is `SANDCHEST_SETUP_TOKEN` if set, else derived from
 * `BETTER_AUTH_SECRET`: stable across restarts and server instances, known
 * only to whoever can read this deployment's environment or its log (it is
 * printed at boot while setup is needed). Nothing is stored: the App's
 * credentials are shown once for the operator to put in the environment, so
 * even a stranger who got through could not attach their App to this server.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const SETUP_COOKIE = "sandchest_setup";
/** GitHub's manifest codes last an hour; so do setup sessions and states. */
const TTL_MS = 60 * 60_000;
const MIN_TOKEN_LENGTH = 24;

type Env = Record<string, string | undefined>;

/** Whether this deployment still needs its GitHub App. */
export function setupNeeded(env: Env = process.env): boolean {
  return !env.GITHUB_APP_ID?.trim();
}

/** The setup token, or undefined when neither source is usable. */
export function setupToken(env: Env = process.env): string | undefined {
  const explicit = env.SANDCHEST_SETUP_TOKEN?.trim();
  if (explicit) return explicit.length >= MIN_TOKEN_LENGTH ? explicit : undefined;
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) return undefined;
  return createHmac("sha256", secret).update("sandchest setup token v1").digest("base64url");
}

/** The deployment's public URL, if valid. Read directly: the full config needs the App this page creates. */
export function appUrl(env: Env = process.env): string | undefined {
  const parsed = z.url({ protocol: /^https?$/ }).safeParse(env.SANDCHEST_APP_URL);
  return parsed.success ? parsed.data.replace(/\/+$/, "") : undefined;
}

/** GitHub's REST API, unless tests point it at a fake. */
export function githubApiUrl(env: Env = process.env): string | undefined {
  const parsed = z.url({ protocol: /^https?$/ }).safeParse(env.GITHUB_API_URL);
  return parsed.success ? parsed.data : undefined;
}

/** The line printed at boot while setup is needed, or undefined once the App exists. */
export function setupAnnouncement(env: Env = process.env): string | undefined {
  if (!setupNeeded(env)) return undefined;
  const base = appUrl(env);
  const token = setupToken(env);
  if (!base) return "Sandchest is not connected to GitHub yet. Set SANDCHEST_APP_URL to this server's public URL, then restart to get a setup link.";
  if (!token) return "Sandchest is not connected to GitHub yet. Set BETTER_AUTH_SECRET (32+ characters), or SANDCHEST_SETUP_TOKEN (24+), then restart to get a setup link.";
  const local = LOOPBACK.test(new URL(base).host) ? "" : ` (or, on the machine running it, the same path on http://localhost:<port>)`;
  return `Sandchest is not connected to GitHub yet. To create its GitHub App, open ${base}/setup/unlock?token=${token}${local}.`;
}

export function tokenMatches(given: string | null | undefined, env: Env = process.env): boolean {
  const token = setupToken(env);
  return Boolean(token && given) && safeEqual(given!.trim(), token!);
}

/** A setup session cookie value: an expiry signed with the token, so it dies with the token and after an hour. */
export function sessionValue(env: Env = process.env, now = Date.now()): string {
  const expires = String(now + TTL_MS);
  return `${expires}.${sign(`session.${expires}`, env)}`;
}

export function sessionValid(value: string | undefined, env: Env = process.env, now = Date.now()): boolean {
  if (!value || !setupToken(env)) return false;
  const [expires, mac, extra] = value.split(".");
  if (!expires || !mac || extra !== undefined || !/^\d{13,}$/.test(expires) || Number(expires) < now) return false;
  return safeEqual(mac, sign(`session.${expires}`, env));
}

/**
 * The `state` sent to GitHub and checked when it sends the operator back. It
 * is signed with the token, so a code from someone else's App creation (a
 * forged callback link) is refused before it is ever exchanged.
 */
export function newState(env: Env = process.env, now = Date.now()): string {
  const expires = String(now + TTL_MS);
  const nonce = randomBytes(16).toString("base64url");
  return `${expires}.${nonce}.${sign(`state.${expires}.${nonce}`, env)}`;
}

export function stateValid(value: string | null | undefined, env: Env = process.env, now = Date.now()): boolean {
  if (!value || !setupToken(env)) return false;
  const [expires, nonce, mac, extra] = value.split(".");
  if (!expires || !nonce || !mac || extra !== undefined || !/^\d{13,}$/.test(expires) || Number(expires) < now) return false;
  return safeEqual(mac, sign(`state.${expires}.${nonce}`, env));
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?$/i;

export type SetupOrigin =
  /** Open on the deployment's public URL, or on this machine: GitHub sends the operator back to `redirectUrl`. */
  | { ok: true; redirectUrl: string; secure: boolean }
  /** Open on some other address, where the setup cookie would not come back: use the public URL. */
  | { ok: false; setupUrl: string };

/**
 * Where GitHub should send the operator back. Only to the deployment's own
 * public URL, or to a loopback address when setup runs on the operator's own
 * machine (how the hosted App is created: run the app locally with
 * `SANDCHEST_APP_URL` set to production). Never to an arbitrary Host header.
 */
export function setupOrigin(headers: Headers, base: string): SetupOrigin {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0]!.trim();
  const publicUrl = new URL(base);
  if (host.toLowerCase() === publicUrl.host.toLowerCase()) return { ok: true, redirectUrl: `${base}/setup/callback`, secure: publicUrl.protocol === "https:" };
  if (LOOPBACK.test(host)) {
    const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https" ? "https" : "http";
    return { ok: true, redirectUrl: `${proto}://${host}/setup/callback`, secure: proto === "https" };
  }
  return { ok: false, setupUrl: `${base}/setup` };
}

function sign(message: string, env: Env): string {
  return createHmac("sha256", setupToken(env)!).update(message).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
