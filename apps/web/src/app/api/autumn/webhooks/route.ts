/**
 * Autumn's webhooks: auto top-up results and plan changes. Off (404) until
 * AUTUMN_WEBHOOK_SECRET is set. The signature is checked against the exact
 * bytes Autumn signed before anything is parsed; a replay older than five
 * minutes is refused, and a fresher one changes nothing, because each event's
 * effect is reserved by a stable key.
 */
import { verifyWebhook } from "@sandchest/billing/webhooks";
import { handleAutumnEvent } from "@/server/autumn-webhooks";
import { config } from "@/server/config";
import { describeError } from "@/server/log";

export const dynamic = "force-dynamic";

/** Autumn's largest events (plan changes) are a few kilobytes. */
const MAX_BYTES = 256 * 1024;

export async function POST(request: Request): Promise<Response> {
  const secret = config().AUTUMN_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "not found" }, { status: 404 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) return Response.json({ error: "too large" }, { status: 413 });
  const body = await request.text();
  if (body.length > MAX_BYTES) return Response.json({ error: "too large" }, { status: 413 });
  const headers = { id: request.headers.get("svix-id"), timestamp: request.headers.get("svix-timestamp"), signature: request.headers.get("svix-signature") };
  if (!verifyWebhook(secret, headers, body)) return Response.json({ error: "invalid signature" }, { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  try {
    return Response.json(await handleAutumnEvent(payload));
  } catch (error) {
    // Autumn retries a failed delivery. Logged by delivery id and error class only: the payload and the
    // error's message can name the customer.
    console.error(`Autumn webhook ${headers.id} failed: ${describeError(error)}`);
    return Response.json({ error: "handling failed" }, { status: 500 });
  }
}
