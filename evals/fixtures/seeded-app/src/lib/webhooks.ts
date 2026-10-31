import { createHmac, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { query } from "./db";
import type { Webhook } from "./types";

const TIMEOUT_MS = 5_000;

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80") || lower.startsWith("::ffff:");
  }
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || a! >= 224;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("Webhooks must use https");
  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Webhook host must be publicly routable");
  }
  return url;
}

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

export async function deliver(webhook: Webhook, event: string, payload: unknown): Promise<number> {
  const url = await assertPublicUrl(webhook.url);
  const body = JSON.stringify({ event, payload, sentAt: new Date().toISOString() });
  const signature = createHmac("sha256", webhook.secret).update(body).digest("hex");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-invoicer-signature": signature },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return response.status;
}

export async function webhooksFor(orgId: string, event: string): Promise<Webhook[]> {
  return query<Webhook>("SELECT * FROM webhooks WHERE org_id = $1 AND active AND $2 = ANY(events)", [orgId, event]);
}

export async function dispatch(orgId: string, event: string, payload: unknown): Promise<void> {
  const hooks = await webhooksFor(orgId, event);
  await Promise.allSettled(hooks.map((hook) => deliver(hook, event, payload)));
}

export async function probe(target: string): Promise<{ status: number; body: string }> {
  const response = await fetch(target, {
    method: "GET",
    headers: { "user-agent": "invoicer-webhook-check/1.0" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.text()).slice(0, 2_000);
  return { status: response.status, body };
}
