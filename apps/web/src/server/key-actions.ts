"use server";
/** API keys and connected agents, from Settings. Each acts only on the signed-in person's own keys. */
import { revokeUserToken } from "@sandchest/db";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { viewer } from "./access";
import { track } from "./analytics";
import { db } from "./db";
import { cleanName, issueKey } from "./agent/tokens";

export type KeyOutcome = { key?: string; error?: string };

export async function createKey(_previous: KeyOutcome, form: FormData): Promise<KeyOutcome> {
  const user = await viewer();
  const name = cleanName(String(form.get("name") ?? ""), "API key");
  const { key } = await issueKey(user.id, name);
  await track("api_key_created", { userId: user.id, props: { via: "settings", kind: "key", outcome: "ok" } });
  revalidatePath("/dashboard/settings");
  return { key };
}

export async function revokeKey(id: string): Promise<void> {
  const user = await viewer();
  if (!z.uuid().safeParse(id).success) return;
  const revoked = await revokeUserToken(db(), user.id, id);
  if (revoked) await track("api_key_revoked", { userId: user.id, props: { via: "settings", kind: revoked.kind, outcome: "ok" } });
  revalidatePath("/dashboard/settings");
}
