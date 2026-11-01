/**
 * Sign-in with GitHub through the GitHub App's own OAuth client, so the
 * user token can list the app's installations the person can see. better-auth
 * signs people in and out and keeps their GitHub tokens (encrypted); pages
 * read the session themselves in one query (see `currentUser`). No cookie
 * cache: server components cannot refresh it, and revocation should be
 * immediate. IP addresses are not recorded and telemetry is off.
 */
import { timingSafeEqual } from "node:crypto";
import { recordEvent, schema, setGithubIdentity } from "@sandchest/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { config } from "./config";
import { SESSION_EXPIRES_IN_S, SESSION_UPDATE_AGE_S } from "./session-token";
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
        // better-auth drops githubUserId and login here (users may not set them), so the hooks below and
        // each access refresh store them; see `setGithubIdentity`.
        mapProfileToUser: (profile) => ({
          name: profile.name || profile.login,
          // Private emails come back empty unless the app may read them; never fail sign-in over it.
          email: profile.email || `${profile.id}+${profile.login}@users.noreply.github.com`,
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
    session: { expiresIn: SESSION_EXPIRES_IN_S, updateAge: SESSION_UPDATE_AGE_S },
    // A new session is a sign-in: recorded for the funnel with the user id only. Never fails sign-in.
    databaseHooks: {
      // The account id is GitHub's numeric user id, so admins are recognised from the first page.
      account: {
        create: {
          after: async (account) => {
            // Never fails sign-in: the next access refresh stores it too.
            if (account.providerId === "github" && /^\d+$/.test(account.accountId)) await setGithubIdentity(db(), account.userId, { id: Number(account.accountId) }).catch(() => {});
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            await recordEvent(db(), { name: "signed_in", userId: session.userId }).catch(() => {});
          },
        },
      },
    },
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

export { sessionCookieName, verifiedSessionToken } from "./session-token";

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
