"use server";
/**
 * The pull requests panel's Review key. The first press prices the review,
 * the second (on a key that names the price) starts it. In its own module,
 * and loading the review code on demand, so pages that only show the panel
 * never trace the workflow runtime.
 */
import { repoForUser } from "@sandchest/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { viewer } from "./access";
import { track } from "./analytics";
import { db } from "./db";
import { describeError } from "./log";
import { captureException } from "./sentry";

export type ReviewOutcome = { credits?: number; error?: string; topUp?: boolean; scanId?: string };

const Input = z.object({ repoId: z.uuid(), prNumber: z.number().int().positive(), credits: z.number().int().min(0).max(100).optional() });

const MESSAGES = {
  not_installed: "Sandchest is no longer installed on this repository.",
  reviews_off: "Pull request reviews are off for this repository.",
  not_open: "This pull request is closed.",
  reviewed: "This commit has already been reviewed.",
  no_plan: "This account needs a plan before Sandchest can review.",
  out_of_credits: "Out of credits for this review.",
} as const;

/** The price of reviewing the PR's latest commit, or why it can't be reviewed. */
export async function quoteReview(repoId: string, prNumber: number): Promise<ReviewOutcome> {
  return run("quote", { repoId, prNumber });
}

/** Starts the review at the price the person confirmed, then opens its live feed. */
export async function startReview(repoId: string, prNumber: number, credits: number): Promise<ReviewOutcome> {
  return run("start", { repoId, prNumber, credits });
}

async function run(step: "quote" | "start", input: { repoId: string; prNumber: number; credits?: number }): Promise<ReviewOutcome> {
  const user = await viewer();
  const parsed = Input.safeParse(input);
  const row = parsed.success ? await repoForUser(db(), user.id, parsed.data.repoId) : undefined;
  if (!parsed.success || !row) {
    await track("pr_review_requested", { userId: user.id, props: { step, outcome: "no_access" } });
    return { error: "You don’t have access to this repository." };
  }
  const record = (outcome: string, extra: { credits?: number; scanId?: string } = {}) =>
    track("pr_review_requested", { userId: user.id, orgId: row.org.id, props: { repo_id: row.repo.id, step, credits: extra.credits ?? null, scan_id: extra.scanId ?? null, outcome } });
  const review = await import("./pr-review");
  const repo = { ...row.repo, org: row.org };
  let result: Awaited<ReturnType<typeof review.startPrReview>>;
  try {
    result = step === "quote" ? await review.quotePrReview(repo, parsed.data.prNumber) : await review.startPrReview(repo, parsed.data.prNumber, parsed.data.credits ?? 0);
  } catch (error) {
    console.error(`PR review ${step} failed: ${describeError(error)}`);
    await captureException(error, { source: "pr_review", tags: { step }, handled: true });
    await record("error");
    return { error: "GitHub didn’t answer. Nothing was charged; try again in a minute." };
  }
  if (!result.ok) {
    await record(result.reason, { credits: result.credits, scanId: "scanId" in result ? result.scanId : undefined });
    // A price that went up since it was shown (someone pushed) is shown again, to be confirmed.
    if (result.reason === "price_changed") return { credits: result.credits, error: "The pull request changed: here’s the new price." };
    if (result.reason === "reviewed") revalidatePath(`/dashboard/repos/${row.repo.id}`);
    const message = result.reason === "out_of_credits" && result.credits ? `Out of credits: this review needs ${result.credits}.` : MESSAGES[result.reason];
    return { error: message, topUp: result.reason === "no_plan" || result.reason === "out_of_credits", scanId: result.scanId };
  }
  await record("ok", { credits: result.credits, scanId: result.scanId || undefined });
  if (step === "quote") return { credits: result.credits };
  redirect(`/dashboard/scans/${result.scanId}`);
}
