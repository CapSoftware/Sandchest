"use server";
/**
 * The Dig button's action, in its own module so pages that only show
 * findings or settings never trace the workflow runtime it needs.
 */
import { repoForUser } from "@sandchest/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { viewer } from "./access";
import { db } from "./db";
import { describeError } from "./log";
import { captureException } from "./sentry";

export type DigOutcome = { error?: string; topUp?: boolean };

export async function dig(repoId: string): Promise<DigOutcome> {
  const user = await viewer();
  const row = z.uuid().safeParse(repoId).success ? await repoForUser(db(), user.id, repoId) : undefined;
  if (!row) return { error: "You don’t have access to this repository." };
  // Loaded on demand: the workflow runtime stays out of every page that merely shows a Dig button.
  const { requestDeepScan } = await import("./dig");
  let result: Awaited<ReturnType<typeof requestDeepScan>>;
  try {
    result = await requestDeepScan({ ...row.repo, org: row.org });
  } catch (error) {
    // GitHub or billing unreachable. Credits held for a scan that never started are given back.
    console.error(`Dig failed: ${describeError(error)}`);
    await captureException(error, { source: "dig", handled: true });
    return { error: "The dig couldn’t start. Nothing was charged; try again in a minute." };
  }
  if (!result.ok) {
    revalidatePath("/repos");
    const messages = {
      not_installed: "Sandchest is no longer installed on this repository.",
      running: "A deep scan is already running.",
      cooling: "This repository was dug in the last 24 hours.",
      too_large: "This repository is over a million lines. Get in touch to scan it.",
      no_plan: `${row.org.githubLogin} needs a plan before Sandchest can dig.`,
      out_of_credits: `Out of credits: this dig needs ${result.credits}.`,
    };
    return { error: messages[result.reason], topUp: result.reason === "no_plan" || result.reason === "out_of_credits" };
  }
  redirect(`/scans/${result.scanId}`);
}
