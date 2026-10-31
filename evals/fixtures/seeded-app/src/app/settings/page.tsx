import { redirect } from "next/navigation";
import { queryOne } from "@/lib/db";
import { currentSession } from "@/lib/session";
import type { Org } from "@/lib/types";
import { membersOf } from "@/lib/users";
import { inviteMember, removeMember, renameOrg } from "./actions";

export default async function SettingsPage() {
  const session = await currentSession();
  if (!session) redirect("/login");
  const org = await queryOne<Org>("SELECT * FROM orgs WHERE id = $1", [session.orgId]);
  const members = await membersOf(session.orgId);

  return (
    <article>
      <h1>Settings</h1>
      <form action={renameOrg}>
        <label>
          Organisation name <input name="name" defaultValue={org?.name} />
        </label>
        <button type="submit">Save</button>
      </form>

      <h2>Members</h2>
      <ul>
        {members.map((member) => (
          <li key={member.id}>
            {member.name || member.email} · {member.role}
            <form action={removeMember}>
              <input type="hidden" name="userId" value={member.id} />
              <button type="submit">Remove</button>
            </form>
          </li>
        ))}
      </ul>

      <h2>Invite</h2>
      <form action={inviteMember}>
        <input type="hidden" name="orgId" value={session.orgId} />
        <input name="email" type="email" placeholder="teammate@example.com" />
        <select name="role" defaultValue="member">
          <option value="admin">Admin</option>
          <option value="member">Member</option>
          <option value="viewer">Viewer</option>
        </select>
        <button type="submit">Send invite</button>
      </form>
    </article>
  );
}
