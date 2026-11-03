"use server";
/**
 * The person's side of connecting an agent: approving (or denying) a device
 * code, or an MCP client's request. Both re-check everything here, since
 * bound arguments come back from the browser.
 */
import { decideDeviceGrant } from "@sandchest/db";
import { redirect } from "next/navigation";
import { viewer } from "./access";
import { track } from "./analytics";
import { db } from "./db";
import { checkAuthorize, issueCode, withParams } from "./agent/oauth";
import { appUrl } from "./agent/run";
import { normaliseUserCode } from "./agent/tokens";

export async function decideDevice(code: string, approve: boolean): Promise<void> {
  const user = await viewer();
  const normal = normaliseUserCode(code);
  const ok = normal ? await decideDeviceGrant(db(), normal, user.id, approve) : false;
  await track("agent_authorized", { userId: user.id, props: { method: "device", outcome: ok ? (approve ? "ok" : "denied") : "expired" } });
  if (!ok) redirect(`/device?error=expired`);
  redirect(`/device?done=${approve ? "approved" : "denied"}`);
}

export async function decideAuthorize(params: Record<string, string | undefined>, approve: boolean): Promise<void> {
  const user = await viewer();
  const checked = await checkAuthorize(params);
  if (!checked.ok) {
    await track("agent_authorized", { userId: user.id, props: { method: "oauth", outcome: "invalid" } });
    redirect("redirect" in checked ? checked.redirect : "/oauth/authorize");
  }
  if (!approve) {
    await track("agent_authorized", { userId: user.id, props: { method: "oauth", outcome: "denied" } });
    redirect(withParams(checked.request.redirectUri, { error: "access_denied", error_description: "The person denied access.", state: checked.request.state, iss: appUrl() }));
  }
  const url = await issueCode(checked.request, user.id);
  await track("agent_authorized", { userId: user.id, props: { method: "oauth", outcome: "ok" } });
  redirect(url);
}
