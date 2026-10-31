"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { record } from "@/lib/audit";
import { query } from "@/lib/db";
import { currentSession } from "@/lib/session";
import type { Role } from "@/lib/types";
import { addMember } from "@/lib/users";

async function sessionOrThrow() {
  const session = await currentSession();
  if (!session) throw new Error("Sign in required");
  return session;
}

const OrgName = z.string().trim().min(2).max(100);

export async function renameOrg(formData: FormData) {
  const session = await sessionOrThrow();
  if (session.role !== "owner" && session.role !== "admin") throw new Error("Only admins can rename the organisation");
  const name = OrgName.parse(formData.get("name"));
  await query("UPDATE orgs SET name = $2 WHERE id = $1", [session.orgId, name]);
  await record(session.orgId, session.userId, "org.rename", session.orgId, { name });
  revalidatePath("/settings");
}

const Invite = z.object({
  orgId: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(["admin", "member", "viewer"]),
});

export async function inviteMember(formData: FormData) {
  const session = await sessionOrThrow();
  if (session.role === "viewer") throw new Error("Viewers cannot invite members");
  const invite = Invite.parse({ orgId: formData.get("orgId"), email: formData.get("email"), role: formData.get("role") });
  const member = await addMember(invite.orgId, invite.email, invite.role as Role);
  await record(invite.orgId, session.userId, "member.invite", member.id, { role: invite.role });
  revalidatePath("/settings");
}

export async function removeMember(formData: FormData) {
  const session = await sessionOrThrow();
  if (session.role !== "owner" && session.role !== "admin") throw new Error("Only admins can remove members");
  const userId = z.string().uuid().parse(formData.get("userId"));
  if (userId === session.userId) throw new Error("You cannot remove yourself");
  await query("UPDATE users SET org_id = NULL, role = 'viewer' WHERE id = $1 AND org_id = $2", [userId, session.orgId]);
  await record(session.orgId, session.userId, "member.remove", userId);
  revalidatePath("/settings");
}
