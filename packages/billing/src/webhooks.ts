/**
 * Autumn's webhooks are delivered by Svix and signed the Standard Webhooks
 * way: an HMAC-SHA256 over `<id>.<timestamp>.<body>`, keyed with the
 * endpoint's `whsec_…` secret, sent as `svix-signature: v1,<base64> …`.
 * Verified here with node:crypto rather than Svix's SDK.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** How far a delivery's timestamp may be from now. Svix's own default. */
export const WEBHOOK_TOLERANCE_S = 5 * 60;

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

function key(secret: string): Buffer {
  return Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
}

/** The `v1,<base64>` signature for a delivery. Exposed for tests and fakes. */
export function signWebhook(secret: string, id: string, timestamp: number | string, body: string): string {
  return `v1,${createHmac("sha256", key(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

/**
 * True when the body was signed with the secret and sent within the
 * tolerance. The header may carry several signatures (during a secret
 * rotation); any one matching is enough.
 */
export function verifyWebhook(secret: string, headers: WebhookHeaders, body: string, now = Date.now()): boolean {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_S) return false;
  const expected = Buffer.from(signWebhook(secret, id, timestamp, body));
  return signature
    .split(" ")
    .map((candidate) => Buffer.from(candidate))
    .some((given) => given.length === expected.length && timingSafeEqual(given, expected));
}
