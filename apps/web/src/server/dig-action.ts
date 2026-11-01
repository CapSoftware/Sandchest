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

export type DigOutcome = { error?: string };

export async function dig(repoId: string): Promise<DigOutcome> {
  const user = await viewer();
  const row = z.uuid().safeParse(repoId).success ? await repoForUser(db(), user.id, repoId) : undefined;
  if (!row) return { error: "You don’t have access to this repository." };
  // Loaded on demand: the workflow runtime stays out of every page that merely shows a Dig button.
  const { requestDeepScan } = await import("./dig");
  const result = await requestDeepScan({ ...row.repo, org: row.org });
  if (!result.ok) {
    revalidatePath("/repos");
    const messages = {
      not_installed: "Sandchest is no longer installed on this repository.",
      running: "A deep scan is already running.",
      cooling: "This repository was dug in the last 24 hours.",
      too_large: "This repository is over a million lines. Get in touch to scan it.",
    };
    return { error: messages[result.reason] };
  }
  redirect(`/scans/${result.scanId}`);
}

