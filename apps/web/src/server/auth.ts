/**
 * Sign-in with GitHub through the GitHub App's own OAuth client, so the
 * user token can list the app's installations the person can see. better-auth
 * signs people in and out and keeps their GitHub tokens (encrypted); pages
 * read the session themselves in one query (see `currentUser`). No cookie
 * cache: server components cannot refresh it, and revocation should be
 * immediate. IP addresses are not recorded and telemetry is off.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { schema } from "@sandchest/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { config } from "./config";
import { db } from "./db";

function createAuth() {
  const settings = config();
  if (!settings.BETTER_AUTH_SECRET || !settings.GITHUB_CLIENT_ID || !settings.GITHUB_CLIENT_SECRET) {
    throw new Error("Sign-in needs BETTER_AUTH_SECRET, GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.");
  }
  return betterAuth({
    appName: "Sandchest",
    baseURL: settings.SANDCHEST_APP_URL,
    secret: settings.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db(), {
      provider: "pg",
      schema: { user: schema.users, session: schema.sessions, account: schema.accounts, verification: schema.verifications },
    }),
    socialProviders: {
      github: {
        clientId: settings.GITHUB_CLIENT_ID,
        clientSecret: settings.GITHUB_CLIENT_SECRET,
        // GitHub App tokens carry the app's permissions; OAuth scopes do not apply.
        disableDefaultScope: true,
        mapProfileToUser: (profile) => ({
          name: profile.name || profile.login,
          // Private emails come back empty unless the app may read them; never fail sign-in over it.
          email: profile.email || `${profile.id}+${profile.login}@users.noreply.github.com`,
          githubUserId: profile.id,
          login: profile.login,
        }),
      },
    },
    user: {
      additionalFields: {
        githubUserId: { type: "number", input: false, required: false },
        login: { type: "string", input: false, required: false },
      },
    },
    account: { encryptOAuthTokens: true, accountLinking: { enabled: false } },
    advanced: { database: { generateId: "uuid" }, ipAddress: { disableIpTracking: true } },
    telemetry: { enabled: false },
    plugins: [nextCookies()],
  });
}

/** Whether this deployment has sign-in configured. Without it the dashboard shows how to set it up. */
export function authConfigured(): boolean {
  const settings = config();
  return Boolean(settings.BETTER_AUTH_SECRET && settings.GITHUB_CLIENT_ID && settings.GITHUB_CLIENT_SECRET);
}

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

let instance: ReturnType<typeof createAuth> | undefined;

export function auth() {
  return (instance ??= createAuth());
}

/** Operator-only access with `Authorization: Bearer <SANDCHEST_ADMIN_TOKEN>`. */
export function isOperator(request: Request): boolean {
  const expected = config().SANDCHEST_ADMIN_TOKEN;
  if (!expected) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${expected}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
