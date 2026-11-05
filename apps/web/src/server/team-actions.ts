"use server";
/**
 * The team, from the dashboard: admins invite, send again, revoke and
 * remove; members leave; an invited person joins from their link. Each
 * action checks who may do it itself (the database writes are scoped to
 * the org's admins, or to the person).
 */
import { leaveOrg, removeMember, revokeInvite } from "@sandchest/db";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { currentUser, viewer } from "./access";
import { track } from "./analytics";
import { auth } from "./auth";
import { db } from "./db";
import { inviteTeammate, joinTeam, type InviteOutcome, type JoinOutcome } from "./team";

const Id = z.uuid();

export type InviteState = { outcome?: InviteOutcome };

/** The invite form: an email address or a GitHub username. */
export async function invitePerson(orgId: string, _previous: InviteState, form: FormData): Promise<InviteState> {
  const user = await viewer();
  const invitee = form.get("invitee");
  if (!Id.safeParse(orgId).success || typeof invitee !== "string") return { outcome: { ok: false, error: "Enter an email address or a GitHub username." } };
  const outcome = await inviteTeammate(user.id, { orgId, invitee });
  if (outcome.ok) revalidatePath("/dashboard/settings");
  return { outcome };
}

/** Sends a pending invite again, with a new link. */
export async function resendInvite(inviteId: string): Promise<InviteOutcome> {
  const user = await viewer();
  if (!Id.safeParse(inviteId).success) return { ok: false, error: "That invite is no longer pending." };
  const outcome = await inviteTeammate(user.id, { resend: inviteId });
  revalidatePath("/dashboard/settings");
  return outcome;
}

export async function revokeTeamInvite(inviteId: string): Promise<void> {
  const user = await viewer();
  if (!Id.safeParse(inviteId).success) return;
  const orgId = await revokeInvite(db(), user.id, inviteId);
  await track("team_invite_revoked", { userId: user.id, orgId: orgId ?? null, props: { outcome: orgId ? "ok" : "not_found" } });
  revalidatePath("/dashboard/settings");
}

export async function removeTeammate(orgId: string, memberId: string): Promise<void> {
  const user = await viewer();
  if (!Id.safeParse(orgId).success || !Id.safeParse(memberId).success) return;
  const ok = await removeMember(db(), user.id, orgId, memberId);
  await track("team_member_removed", { userId: user.id, orgId: ok ? orgId : null, props: { self: false, outcome: ok ? "ok" : "not_found" } });
  revalidatePath("/dashboard/settings");
}

export async function leaveTeam(orgId: string): Promise<void> {
  const user = await viewer();
  if (!Id.safeParse(orgId).success) return;
  const ok = await leaveOrg(db(), user.id, orgId);
  await track("team_member_removed", { userId: user.id, orgId: ok ? orgId : null, props: { self: true, outcome: ok ? "ok" : "not_found" } });
  revalidatePath("/dashboard", "layout");
  redirect("/dashboard/settings");
}

export type JoinState = { outcome?: JoinOutcome };

/** Signs out and comes back to the invite, to sign in as the person it's for. */
export async function switchAccount(token: string): Promise<void> {
  const user = await currentUser().catch(() => undefined);
  await track("signed_out", { userId: user?.id });
  await auth().api.signOut({ headers: await headers() });
  redirect(/^[A-Za-z0-9_-]{43}$/.test(token) ? `/invite/${token}` : "/");
}

/** "Join" on an invite's page. Goes to the dashboard once in. */
export async function acceptTeamInvite(token: string, _previous: JoinState): Promise<JoinState> {
  // Signed out (the session ended while the page was open): sign in and come back here.
  const user = await currentUser();
  if (!user) redirect(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`);
  const outcome = await joinTeam(user.id, token);
  if (outcome.ok) {
    revalidatePath("/dashboard", "layout");
    redirect("/dashboard/repos");
  }
  if (outcome.reason === "signed_out") redirect(`/sign-in?expired=1&next=${encodeURIComponent(`/invite/${token}`)}`);
  return { outcome };
}
