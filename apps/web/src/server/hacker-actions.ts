"use server";
/** Customizing an org's hacker after recruiting: the same person, a new look. Admins only. */
import { updateOrgSettings } from "@sandchest/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { HackerProfile } from "@/lib/hacker";
import { viewer } from "./access";
import { db } from "./db";
import { HackerSchema } from "./hacker-schema";

export type SaveHackerOutcome = { error: string } | { ok: true };

/** Saves the hacker's look, voice and name. */
export async function saveHacker(orgId: string, raw: HackerProfile): Promise<SaveHackerOutcome> {
  const user = await viewer();
  const input = HackerSchema.safeParse(raw);
  if (!z.uuid().safeParse(orgId).success) return { error: "Only an admin of this account can change its hacker." };
  if (!input.success) return { error: "Check the name: letters, numbers, spaces, dots and dashes, up to 16." };
  const hacker = { ...input.data, stickers: [...new Set(input.data.stickers)] };
  if (!(await updateOrgSettings(db(), user.id, orgId, { hacker }))) return { error: "Only an admin of this account can change its hacker." };
  revalidatePath("/dashboard", "layout");
  return { ok: true };
}
