import type { OrgTeam } from "@sandchest/db";
import type { TeamRow } from "@/components/app/team";
import { timeAgo, timeUntil } from "./format";

/** An org's team as Settings lists it: admins first, then people by name, then invites, newest first. */
export function teamRows(team: OrgTeam | undefined, now = Date.now()): TeamRow[] {
  if (!team) return [];
  const people = team.people.map((person): TeamRow => {
    const handle = person.login ? `@${person.login}` : null;
    const note = person.admin
      ? "Admin"
      : person.member
        ? `Invited${person.joinedAt ? `, joined ${timeAgo(person.joinedAt, now)}` : ""}`
        : "Write access on GitHub";
    return { key: `p:${person.userId}`, kind: "person", id: person.userId, image: person.image, name: person.name || handle || "Someone", handle, note, actionable: person.member };
  });
  const invites = team.invites.map((invite): TeamRow => {
    const expired = invite.expiresAt.getTime() <= now;
    const who = invite.email ?? `@${invite.githubLogin}`;
    return {
      key: `i:${invite.id}`,
      kind: "invite",
      id: invite.id,
      image: invite.githubLogin ? `https://avatars.githubusercontent.com/${encodeURIComponent(invite.githubLogin)}` : null,
      name: who,
      handle: invite.email ? null : who,
      note: expired ? "Invite expired" : `Expires ${timeUntil(invite.expiresAt, now)}`,
      actionable: true,
      expired,
    };
  });
  return [...people, ...invites];
}
