"use server";
/**
 * Everything a person can change from the dashboard. Each action checks
 * access itself: the database writes are scoped to what the viewer may see.
 */
import { applyFindingAction, FINDING_LIST_LIMIT, findingsForExport, recordPromptCopied, recordPromptsCopied, updateOrgSettings, type FindingAction } from "@sandchest/db";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { currentUser, viewer } from "./access";
import { routeOf } from "@/lib/analytics";
import { agentPrompt, exportFindings } from "@/lib/findings-export";
import { SEVERITIES } from "@/lib/format";
import { site } from "@/lib/site";
import { track } from "./analytics";
import { auth } from "./auth";
import { config } from "./config";
import { db } from "./db";

const Id = z.uuid();

export async function signIn(next: string): Promise<void> {
  return signInWith("github", next);
}

export async function signInWithForgejo(next: string): Promise<void> {
  return signInWith("forgejo", next);
}

async function signInWith(provider: "github" | "forgejo", next: string): Promise<void> {
  // Checked again here: a bound argument can be changed by the client.
  const callbackURL = /^\/(?![/\\])/.test(next) ? next : "/dashboard";
  await track("sign_in_started", { props: { next: routeOf(callbackURL) } });
  const result = await auth().api.signInSocial({ body: { provider, callbackURL, errorCallbackURL: "/sign-in?error=1" }, headers: await headers() });
  if (!result.url) throw new Error(`Sign-in with ${provider} did not return a URL`);
  redirect(result.url);
}

export async function signOut(): Promise<void> {
  const user = await currentUser().catch(() => undefined);
  await track("signed_out", { userId: user?.id });
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

const ExportFilters = z.object({
  status: z.enum(["open", "fixed", "dismissed"]),
  severities: z.array(z.enum(SEVERITIES as ["critical", "high", "medium", "low"])).max(SEVERITIES.length),
  repo: z.uuid().optional(),
  low: z.boolean(),
});

export type ExportFiltersInput = z.infer<typeof ExportFilters>;

/** How a prepared agent prompt left the page: copied as the prompt or a command, or opened in an app. */
const HandOff = z.enum(["prompt", "claude", "codex", "open_t3", "open_claude", "open_codex", "open_cursor"]);
export type HandOff = z.infer<typeof HandOff>;

function listFilters(input: ExportFiltersInput) {
  const filters = ExportFilters.safeParse(input);
  if (!filters.success) return undefined;
  const { status, severities, repo, low } = filters.data;
  return { status, severities, repoId: repo, includeLowConfidence: low };
}

/**
 * The agent prompt for the open findings as the viewer filtered them: the
 * same query as the page, so it covers what was on screen. Prepared when the
 * copy menu opens, so opening it in an app needs no wait after the click.
 * Records nothing; `findingsTaken` does once it's used.
 */
export async function findingsPrompt(input: ExportFiltersInput): Promise<{ text: string; ids: string[]; repos: string[] } | { error: string }> {
  const user = await viewer();
  const filters = listFilters(input);
  if (!filters) return { error: "Those filters aren’t valid." };
  // Fixed and dismissed findings have nothing left for an agent to do.
  if (filters.status !== "open") return { error: "Only open findings can be handed to an agent." };
  const rows = await findingsForExport(db(), user.id, filters);
  return { text: agentPrompt(rows), ids: rows.map((row) => row.id), repos: [...new Set(rows.map((row) => row.repoFullName))] };
}

/** A prepared prompt was copied or opened in an app: counts as taking each finding's fix prompt. */
export async function findingsTaken(input: ExportFiltersInput, findingIds: string[], via: HandOff): Promise<void> {
  const user = await viewer();
  const filters = listFilters(input);
  const ids = z.array(Id).max(FINDING_LIST_LIMIT).safeParse(findingIds);
  if (!filters || !ids.success || !HandOff.safeParse(via).success) return;
  await Promise.all([
    recordPromptsCopied(db(), user.id, ids.data),
    track("findings_copied", {
      userId: user.id,
      props: { format: via, status: filters.status, findings: ids.data.length, filtered: filters.severities.length > 0 || filters.repoId !== undefined, low_confidence: filters.includeLowConfidence },
    }),
  ]);
}

/** The findings list as the viewer filtered it, as a Markdown report or JSON. */
export async function copyFindings(input: ExportFiltersInput, format: "markdown" | "json"): Promise<{ text: string; count: number } | { error: string }> {
  const user = await viewer();
  const filters = listFilters(input);
  if (!filters || (format !== "markdown" && format !== "json")) return { error: "Those filters aren’t valid." };
  const rows = await findingsForExport(db(), user.id, filters);
  const text = exportFindings(rows, format, { baseUrl: site.url, forgejoUrl: config().forgejo?.url, filters: { status: filters.status, severities: filters.severities, repo: filters.repoId, includeLowConfidence: filters.includeLowConfidence } });
  await track("findings_copied", {
    userId: user.id,
    props: { format, status: filters.status, findings: rows.length, repos: new Set(rows.map((row) => row.repoFullName)).size, filtered: filters.severities.length > 0 || filters.repoId !== undefined, low_confidence: filters.includeLowConfidence },
  });
  return { text, count: rows.length };
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
  await track("org_settings_saved", {
    userId: user.id,
    orgId: ok ? orgId : null,
    props: { check_threshold: parsed.data.checkThreshold, email_notifications: parsed.data.emailNotifications === "on", outcome: ok ? "ok" : "not_admin" },
  });
  if (!ok) return { error: "Only an admin of this account can change its settings." };
  revalidatePath("/dashboard/settings");
  return { saved: true };
}
