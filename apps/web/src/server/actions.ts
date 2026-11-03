"use server";
/**
 * Everything a person can change from the dashboard. Each action checks
 * access itself: the database writes are scoped to what the viewer may see.
 */
import { applyFindingAction, findingsForExport, recordPromptCopied, recordPromptsCopied, updateOrgSettings, type FindingAction } from "@sandchest/db";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { currentUser, viewer } from "./access";
import { routeOf } from "@/lib/analytics";
import { AGENT_FORMATS, EXPORT_FORMATS, exportFindings, type ExportFormat } from "@/lib/findings-export";
import { SEVERITIES } from "@/lib/format";
import { site } from "@/lib/site";
import { track } from "./analytics";
import { auth } from "./auth";
import { db } from "./db";

const Id = z.uuid();

export async function signIn(next: string): Promise<void> {
  // Checked again here: a bound argument can be changed by the client.
  const callbackURL = /^\/(?![/\\])/.test(next) ? next : "/dashboard";
  await track("sign_in_started", { props: { next: routeOf(callbackURL) } });
  const result = await auth().api.signInSocial({ body: { provider: "github", callbackURL, errorCallbackURL: "/sign-in?error=1" }, headers: await headers() });
  if (!result.url) throw new Error("GitHub sign-in did not return a URL");
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

/**
 * The findings list as the viewer filtered it, in one of the copy formats.
 * The same query as the page, so what is copied is what was on screen.
 */
/** Linux refuses a single command-line argument over 128 KiB (MAX_ARG_STRLEN); leave room for the command around it. */
const COMMAND_ARGUMENT_LIMIT = 120_000;

export async function copyFindings(input: ExportFiltersInput, format: ExportFormat): Promise<{ text: string; count: number; note?: string } | { error: string }> {
  const user = await viewer();
  const filters = ExportFilters.safeParse(input);
  if (!filters.success || !EXPORT_FORMATS.includes(format)) return { error: "Those filters aren’t valid." };
  const { status, severities, repo, low } = filters.data;
  // Fixed and dismissed findings have nothing left for an agent to do.
  if (AGENT_FORMATS.includes(format) && status !== "open") return { error: "Only open findings can be handed to an agent." };
  const rows = await findingsForExport(db(), user.id, { status, severities, repoId: repo, includeLowConfidence: low });
  const text = exportFindings(rows, format, { baseUrl: site.url, filters: { status, severities, repo, includeLowConfidence: low } });
  await Promise.all([
    AGENT_FORMATS.includes(format) ? recordPromptsCopied(db(), user.id, rows.map((row) => row.id)) : undefined,
    track("findings_copied", {
      userId: user.id,
      props: { format, status, findings: rows.length, repos: new Set(rows.map((row) => row.repoFullName)).size, filtered: severities.length > 0 || repo !== undefined, low_confidence: low },
    }),
  ]);
  const tooLong = (format === "claude" || format === "codex") && text.length > COMMAND_ARGUMENT_LIMIT;
  return { text, count: rows.length, note: tooLong ? "That command may be too long for a Linux shell. Filter by repository, or copy the Prompt and paste it in." : undefined };
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
