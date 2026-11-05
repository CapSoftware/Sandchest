/**
 * An account's team: everyone who can see its repositories, and invites.
 * Admins only. Joining stays in the browser: GitHub has to confirm the
 * person opening the link is the one it was sent to.
 */
import { adminTeams, removeMember, revokeInvite, setMemberRole, TEAM_ROLES } from "@sandchest/db";
import { z } from "zod";
import { track } from "../../analytics";
import { db } from "../../db";
import { inviteTeammate } from "../../team";
import { ApiError, notAdmin, notFound } from "../errors";
import { AccountRef, operation, Uuid } from "../operation";
import { resolveAccount } from "../resolve";
import { iso } from "../views";

async function adminAccount(context: Parameters<typeof resolveAccount>[0], ref: string) {
  const org = await resolveAccount(context, ref);
  if (!org.admin) throw notAdmin(org.login);
  return org;
}

export const teamOps = [
  operation({
    name: "list_team",
    title: "List an account's team",
    description:
      "Everyone who can see the account's repositories in Sandchest, with their role (admin or member) and where it comes from (GitHub, or an invite), plus pending invites. Admins only.",
    method: "GET",
    path: "/accounts/{account}/team",
    input: z.object({ account: AccountRef }),
    readOnly: true,
    async run(context, input) {
      const org = await adminAccount(context, input.account);
      const team = (await adminTeams(db(), context.principal.userId)).get(org.id) ?? { people: [], invites: [] };
      return {
        account: { id: org.id, login: org.login },
        people: team.people.map((person) => ({
          user_id: person.userId,
          name: person.name,
          login: person.login,
          role: person.admin ? "admin" : "member",
          via: person.githubAdmin || !person.member ? "github" : "invite",
          // Only roles an invite gave can be changed here; GitHub's are changed on GitHub.
          role_changeable: person.member && !person.githubAdmin,
          joined_at: iso(person.joinedAt),
        })),
        invites: team.invites.map((invite) => ({
          id: invite.id,
          email: invite.email,
          github_login: invite.githubLogin,
          role: invite.role,
          invited_by: invite.invitedBy,
          created_at: iso(invite.createdAt),
          expires_at: iso(invite.expiresAt),
          expired: invite.expiresAt.getTime() <= Date.now(),
        })),
      };
    },
  }),

  operation({
    name: "invite_teammate",
    title: "Invite someone to an account's team",
    description:
      "Invites a person by email address or GitHub username (admins only), as a member (default) or an admin. Both see every repository Sandchest watches on the account and can scan, review and resolve findings; an admin can also change the account's settings, billing and team. An email invite is sent by email when the server can send it; otherwise, and always for a GitHub username, the response's link must be given to them. The link works once, for 7 days, and only for that person: they sign in with GitHub, which must list the address as verified or be that account. Inviting someone again replaces their pending invite.",
    method: "POST",
    path: "/accounts/{account}/team/invites",
    input: z.object({
      account: AccountRef,
      invitee: z.string().trim().min(1).max(254).describe("An email address, or a GitHub username (with or without @)."),
      role: z.enum(TEAM_ROLES).optional().describe("member (default) or admin."),
    }),
    async run(context, input) {
      const org = await adminAccount(context, input.account);
      const outcome = await inviteTeammate(context.principal.userId, { orgId: org.id, invitee: input.invitee, role: input.role ?? "member" });
      if (!outcome.ok) throw new ApiError(422, "invite_refused", outcome.error);
      return {
        invite_id: outcome.inviteId,
        invitee: outcome.who,
        role: outcome.role,
        emailed: outcome.emailed,
        // Shown once: it's the only way in for a GitHub username, or when no email went.
        link: outcome.emailed ? null : outcome.link,
        hint: outcome.emailed ? `Sent to ${outcome.who}.` : `Give ${outcome.who} this link; it isn't shown again.`,
      };
    },
  }),

  operation({
    name: "revoke_invite",
    title: "Revoke an invite",
    description: "Revokes a pending invite so its link stops working (admins only).",
    method: "DELETE",
    path: "/accounts/{account}/team/invites/{id}",
    input: z.object({ account: AccountRef, id: Uuid("invite") }),
    destructive: true,
    async run(context, input) {
      const org = await adminAccount(context, input.account);
      const orgId = await revokeInvite(db(), context.principal.userId, input.id);
      await track("team_invite_revoked", { userId: context.principal.userId, orgId: orgId ?? null, props: { outcome: orgId ? "ok" : "not_found", via: context.surface } });
      if (orgId !== org.id) throw notFound("pending invite");
      return { revoked: true };
    },
  }),

  operation({
    name: "set_teammate_role",
    title: "Change a teammate's role",
    description:
      "Makes someone who joined by invite a member or an admin (admins only). Takes effect at once. Admins on GitHub stay admins whatever this says; change that on GitHub.",
    method: "PATCH",
    path: "/accounts/{account}/team/members/{user_id}",
    input: z.object({ account: AccountRef, user_id: Uuid("person"), role: z.enum(TEAM_ROLES) }),
    idempotent: true,
    async run(context, input) {
      const org = await adminAccount(context, input.account);
      const ok = await setMemberRole(db(), context.principal.userId, org.id, input.user_id, input.role);
      await track("team_role_changed", {
        userId: context.principal.userId,
        orgId: ok ? org.id : null,
        props: { role: input.role, self: input.user_id === context.principal.userId, outcome: ok ? "ok" : "not_found", via: context.surface },
      });
      if (!ok) throw notFound("invited member");
      return { user_id: input.user_id, role: input.role };
    },
  }),

  operation({
    name: "remove_teammate",
    title: "Remove someone from an account's team",
    description:
      "Removes a person who joined by invite (admins only): what the invite gave them goes at once. People with write access on GitHub keep it; change that on GitHub.",
    method: "DELETE",
    path: "/accounts/{account}/team/members/{user_id}",
    input: z.object({ account: AccountRef, user_id: Uuid("person") }),
    destructive: true,
    async run(context, input) {
      const org = await adminAccount(context, input.account);
      const ok = await removeMember(db(), context.principal.userId, org.id, input.user_id);
      await track("team_member_removed", { userId: context.principal.userId, orgId: ok ? org.id : null, props: { self: false, outcome: ok ? "ok" : "not_found", via: context.surface } });
      if (!ok) throw notFound("invited member");
      return { removed: true };
    },
  }),
];
