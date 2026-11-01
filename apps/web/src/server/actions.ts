"use server";
/**
 * Everything a person can change from the dashboard. Each action checks
 * access itself: the database writes are scoped to what the viewer may see.
 */
import { applyFindingAction, recordPromptCopied, updateOrgSettings, type FindingAction } from "@sandchest/db";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { viewer } from "./access";
import { auth } from "./auth";
import { db } from "./db";

const Id = z.uuid();

export async function signIn(next: string): Promise<void> {
  // Checked again here: a bound argument can be changed by the client.
  const callbackURL = /^\/(?![/\\])/.test(next) ? next : "/dashboard";
  const result = await auth().api.signInSocial({ body: { provider: "github", callbackURL, errorCallbackURL: "/sign-in?error=1" }, headers: await headers() });
  if (!result.url) throw new Error("GitHub sign-in did not return a URL");
  redirect(result.url);
}

export async function signOut(): Promise<void> {
  await auth().api.signOut({ headers: await headers() });
  redirect("/");
}

const FindingForm = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dismiss"), reason: z.enum(["false_positive", "accepted_risk", "wont_fix"]) }),
  z.object({ type: z.literal("fix") }),
  z.object({ type: z.literal("reopen") }),
]);

export async function changeFinding(findingId: string, form: FormData): Promise<void> {
  const user = await viewer();
  const action = FindingForm.safeParse(Object.fromEntries(form));
  if (!action.success || !Id.safeParse(findingId).success) return;
  if (await applyFindingAction(db(), user.id, findingId, action.data as FindingAction)) {
    revalidatePath(`/dashboard/findings/${findingId}`);
    revalidatePath("/dashboard/findings");
    revalidatePath("/dashboard");
  }
}

export async function promptTaken(findingId: string): Promise<void> {
  const user = await viewer();
  if (Id.safeParse(findingId).success) await recordPromptCopied(db(), user.id, findingId);
}

const SettingsForm = z.object({
  checkThreshold: z.enum(["critical", "high", "medium", "low"]),
  emailNotifications: z.literal("on").optional(),
});

export type SettingsOutcome = { saved?: boolean; error?: string };

export async function saveOrgSettings(orgId: string, _previous: SettingsOutcome, form: FormData): Promise<SettingsOutcome> {
  const user = await viewer();
  const parsed = SettingsForm.safeParse(Object.fromEntries(form));
  if (!parsed.success || !Id.safeParse(orgId).success) return { error: "Those settings aren’t valid." };
  const ok = await updateOrgSettings(db(), user.id, orgId, { checkThreshold: parsed.data.checkThreshold, emailNotifications: parsed.data.emailNotifications === "on" });
  if (!ok) return { error: "Only an admin of this account can change its settings." };
  revalidatePath("/dashboard/settings");
  return { saved: true };
}
