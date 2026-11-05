/**
 * Inviting people to an org, and joining one. An admin invites an email
 * address or a GitHub account; the link carries a random token (only its
 * hash is stored) and works only for that person: GitHub must say the
 * person signing in has verified that address, or is that account. Shared by
 * the dashboard's actions and the agent API.
 */
import { createHash, randomBytes } from "node:crypto";
import { acceptInvite, createInvite, INVITE_TTL_DAYS, inviteByTokenHash, orgForAdmin, pendingInvitee, userById, type AcceptResult, type Invitee } from "@sandchest/db";
import { teamInviteEmail } from "@sandchest/email";
import { findGithubUser, GitHubError, readIdentity, type HttpOptions } from "@sandchest/github";
import { withUtm } from "@/lib/analytics";
import { githubToken } from "./access";
import { track } from "./analytics";
import { config } from "./config";
import { db } from "./db";
import { describeError } from "./log";
import { mailer } from "./mailer";
import { admit } from "./rate-limit";

/** GitHub's rule for logins: letters, digits and single hyphens, not at either end, at most 39. */
const LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
/** A deliberately plain check: one @, no spaces or angle brackets, a dot in the domain. GitHub decides the rest. */
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
/** The link's token: 32 random bytes, base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Who the admin typed: an email address, or a GitHub login with or without its @. */
export function parseInvitee(raw: string): { email: string } | { login: string } | undefined {
  const value = raw.trim();
  if (value.length === 0 || value.length > 254) return undefined;
  if (value.includes("@") && !value.startsWith("@")) return EMAIL.test(value) ? { email: value.toLowerCase() } : undefined;
  const login = value.replace(/^@/, "");
  return LOGIN.test(login) ? { login } : undefined;
}

const githubHttp = (http?: HttpOptions): HttpOptions => ({ baseUrl: config().GITHUB_API_URL, ...http });

/** For tests: the person's GitHub token and a fake GitHub, instead of the stored token and the real API. */
export interface GithubAccess {
  token?: string;
  http?: HttpOptions;
}

function inviteUrl(token: string): string {
  return `${config().SANDCHEST_APP_URL.replace(/\/$/, "")}/invite/${token}`;
}

export type InviteOutcome =
  | {
      ok: true;
      inviteId: string;
      /** Who it's for, as the admin will recognise them. */
      who: string;
      /** The link: shown to the admin once, to send themselves when there's no email (or it didn't go). */
      link: string;
      emailed: boolean;
    }
  | { ok: false; error: string };

const REFUSED: Record<"not_admin" | "already_member" | "limited" | "self", string> = {
  not_admin: "Only an admin of this account can invite people.",
  self: "That’s you. You’re already on the team.",
  already_member: "They’re already on the team.",
  limited: "That’s a lot of invites at once. Try again in a little while.",
};

/**
 * An admin invites someone, or sends a pending invite again (`resend`, an
 * invite id: its old link stops working). Emails the link when the invitee
 * is an address and email is set up.
 */
export async function inviteTeammate(userId: string, request: { orgId: string; invitee: string } | { resend: string }, github: GithubAccess = {}): Promise<InviteOutcome> {
  const resend = "resend" in request;
  const fail = async (outcome: string, error: string, orgId: string | null = null, kind: string | null = null): Promise<InviteOutcome> => {
    await track("team_invite_sent", { userId, orgId, props: { kind, resend, outcome } });
    return { ok: false, error };
  };
  // Bounds GitHub lookups and emails per person on this instance; the database keeps the real limits.
  if (!admit(`team-invite:${userId}`, 20, 60_000)) return fail("limited", REFUSED.limited);

  let orgId: string;
  let invitee: Invitee;
  if (resend) {
    const pending = await pendingInvitee(db(), userId, request.resend);
    if (!pending) return fail("not_admin", "That invite is no longer pending.");
    ({ orgId, invitee } = pending);
  } else {
    orgId = request.orgId;
    const parsed = parseInvitee(request.invitee);
    if (!parsed) return fail("invalid", "Enter an email address or a GitHub username.", orgId);
    // Admins only, before asking GitHub anything.
    if (!(await orgForAdmin(db(), userId, orgId))) return fail("not_admin", REFUSED.not_admin, null, "email" in parsed ? "email" : "github");
    if ("email" in parsed) invitee = parsed;
    else {
      let found: { id: number; login: string } | undefined;
      try {
        found = await findGithubUser(github.token ?? (await githubToken(userId)), parsed.login, githubHttp(github.http));
      } catch (error) {
        logError("team: GitHub user lookup failed", error);
        return fail("error", "GitHub didn’t answer. Try again.", orgId, "github");
      }
      if (!found) return fail("no_such_user", `There’s no GitHub user called ${parsed.login}.`, orgId, "github");
      invitee = { githubUserId: found.id, githubLogin: found.login };
    }
  }
  const kind = "email" in invitee ? "email" : "github";

  const token = randomBytes(32).toString("base64url");
  const created = await createInvite(db(), { userId, orgId, invitee, tokenHash: hashToken(token) });
  if (!created.ok) return fail(created.reason, REFUSED[created.reason], created.reason === "not_admin" ? null : orgId, kind);

  const link = inviteUrl(token);
  let emailed = false;
  if ("email" in invitee && mailer().enabled) {
    const inviter = await inviterLogin(userId);
    try {
      await mailer().send({ to: [invitee.email], ...teamInviteEmail({ org: created.orgLogin, inviter, url: withUtm(link, "email", "team_invite"), days: INVITE_TTL_DAYS }) });
      emailed = true;
    } catch (error) {
      logError("team: invite email failed", error);
    }
  }
  await track("team_invite_sent", { userId, orgId, props: { kind, resend, outcome: "ok", emailed } });
  return { ok: true, inviteId: created.id, who: "email" in invitee ? invitee.email : `@${invitee.githubLogin}`, link, emailed };
}

function logError(what: string, error: unknown): void {
  console.error(`${what}: ${describeError(error)}`);
}

async function inviterLogin(userId: string): Promise<string> {
  const user = await userById(db(), userId);
  // Logins are GitHub's restricted alphabet; anything else (never expected) is not put in an email.
  return user?.login && LOGIN.test(user.login) ? user.login : "someone";
}

export type JoinOutcome = AcceptResult | { ok: false; reason: "github_error" | "signed_out" | "limited"; orgId?: string };

/**
 * Joins the org an invite link is for, as `userId`, if GitHub says they are
 * the person it was sent to.
 */
export async function joinTeam(userId: string, token: string, github: GithubAccess = {}): Promise<JoinOutcome> {
  const done = async (outcome: JoinOutcome, kind: string | null = null): Promise<JoinOutcome> => {
    await track("team_invite_accepted", { userId, orgId: outcome.ok ? outcome.orgId : (outcome.orgId ?? null), props: { kind, outcome: outcome.ok ? "ok" : outcome.reason } });
    return outcome;
  };
  if (!TOKEN.test(token)) return done({ ok: false, reason: "not_found" });
  if (!admit(`team-join:${userId}`, 10, 60_000)) return done({ ok: false, reason: "limited" });
  const tokenHash = hashToken(token);
  const invite = await inviteByTokenHash(db(), tokenHash);
  if (!invite || !invite.pending) return done({ ok: false, reason: "not_found" });
  const kind = invite.email !== null ? "email" : "github";

  let identity: { id: number; verifiedEmails: string[] };
  try {
    identity = await readIdentity(github.token ?? (await githubToken(userId)), { emails: invite.email !== null, http: githubHttp(github.http) });
  } catch (error) {
    if (error instanceof GitHubError && error.status === 401) return done({ ok: false, reason: "signed_out", orgId: invite.orgId }, kind);
    logError("team: reading the invitee from GitHub failed", error);
    return done({ ok: false, reason: "github_error", orgId: invite.orgId }, kind);
  }
  return done(await acceptInvite(db(), { userId, tokenHash, identity: { githubUserId: identity.id, verifiedEmails: identity.verifiedEmails } }), kind);
}

/** An invite link's details, for its page; nothing for a link that can't be one. */
export async function inviteForLink(token: string) {
  return TOKEN.test(token) ? inviteByTokenHash(db(), hashToken(token)) : undefined;
}
