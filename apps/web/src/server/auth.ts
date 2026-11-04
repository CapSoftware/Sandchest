/**
 * Sign-in with GitHub through the GitHub App's own OAuth client, so the
 * user token can list the app's installations the person can see, and with
 * Forgejo through an OAuth2 application on the instance. better-auth
 * signs people in and out and keeps their GitHub tokens (encrypted); pages
 * read the session themselves in one query (see `currentUser`). No cookie
 * cache: server components cannot refresh it, and revocation should be
 * immediate. IP addresses are not recorded and telemetry is off.
 */
import { timingSafeEqual } from "node:crypto";
import { schema, setGithubIdentity } from "@sandchest/db";
import { anonId, recordLater } from "./analytics";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { config, type Config } from "./config";
import { SESSION_EXPIRES_IN_S, SESSION_UPDATE_AGE_S } from "./session-token";
import { db } from "./db";

function createAuth() {
  const settings = config();
  if (!settings.BETTER_AUTH_SECRET || (!githubSignIn(settings) && !forgejoSignIn(settings))) {
    throw new Error("Sign-in needs BETTER_AUTH_SECRET, and GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET or FORGEJO_CLIENT_ID and FORGEJO_CLIENT_SECRET.");
  }
  const forgejo = forgejoSignIn(settings) ? settings.forgejo! : undefined;
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
        enabled: githubSignIn(settings),
        clientId: settings.GITHUB_CLIENT_ID ?? "",
        clientSecret: settings.GITHUB_CLIENT_SECRET ?? "",
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
    // A new session is a sign-in: recorded for the funnel with opaque ids only. Never fails sign-in.
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
      // A new user is a sign-up; it comes with the browser's anonymous id, which ties the visits before it to them.
      user: {
        create: {
          after: async (user) => {
            recordLater([{ name: "signed_up", userId: user.id, anonId: await anonId() }]);
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            recordLater([{ name: "signed_in", userId: session.userId, anonId: await anonId() }]);
          },
        },
      },
    },
    advanced: { database: { generateId: "uuid" }, ipAddress: { disableIpTracking: true } },
    telemetry: { enabled: false },
    plugins: [
      nextCookies(),
      ...(forgejo
        ? [
            genericOAuth({
              config: [
                {
                  providerId: "forgejo",
                  name: "Forgejo",
                  clientId: settings.FORGEJO_CLIENT_ID!,
                  clientSecret: settings.FORGEJO_CLIENT_SECRET!,
                  authorizationUrl: `${forgejo.url}/login/oauth/authorize`,
                  tokenUrl: `${forgejo.url}/login/oauth/access_token`,
                  // Honoured when the instance allows OAuth2 scopes (ENABLE_ADDITIONAL_GRANT_SCOPES); otherwise the token may do what the person may.
                  scopes: ["read:user", "read:repository", "read:organization"],
                  // The REST profile rather than OpenID's: its numeric id is the account id, as with GitHub.
                  getUserInfo: async (tokens) => {
                    const response = await fetch(`${forgejo.apiUrl}/user`, { headers: { authorization: `Bearer ${tokens.accessToken}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
                    if (!response.ok) return null;
                    const profile = (await response.json()) as { id: number; login: string; full_name?: string; email?: string; avatar_url?: string };
                    const host = new URL(forgejo.url).hostname;
                    return {
                      id: String(profile.id),
                      name: profile.full_name || profile.login,
                      // Never fail sign-in over a hidden email.
                      email: profile.email || `${profile.id}+${profile.login}@users.noreply.${host}`,
                      emailVerified: false,
                      image: profile.avatar_url,
                    };
                  },
                },
              ],
            }),
          ]
        : []),
    ],
  });
}

function githubSignIn(settings: Config): boolean {
  return Boolean(settings.GITHUB_CLIENT_ID && settings.GITHUB_CLIENT_SECRET);
}

function forgejoSignIn(settings: Config): boolean {
  return Boolean(settings.forgejo && settings.FORGEJO_CLIENT_ID && settings.FORGEJO_CLIENT_SECRET);
}

/** Whether this deployment has sign-in configured. Without it the dashboard shows how to set it up. */
export function authConfigured(): boolean {
  const settings = config();
  return Boolean(settings.BETTER_AUTH_SECRET && (githubSignIn(settings) || forgejoSignIn(settings)));
}

/** The forges people can sign in with here, GitHub first. */
export function signInProviders(): Array<"github" | "forgejo"> {
  const settings = config();
  if (!settings.BETTER_AUTH_SECRET) return [];
  return [...(githubSignIn(settings) ? (["github"] as const) : []), ...(forgejoSignIn(settings) ? (["forgejo"] as const) : [])];
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
