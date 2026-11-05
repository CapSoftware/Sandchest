import { verifySignature } from "@sandchest/github";
import { billingEnabled, canScan } from "@/server/billing";
import { config } from "@/server/config";
import { describeError } from "@/server/log";
import { db, githubApp } from "@/server/services";
import { startInventory, startScan } from "@/server/start";
import { handleWebhook } from "@/server/webhooks";
import { captureException, webhookEventTag } from "@/server/sentry";

export const dynamic = "force-dynamic";

/** GitHub caps webhook payloads at 25 MB and drops larger events, so no genuine delivery is bigger. */
const MAX_BYTES = 25 * 1024 * 1024;

/** The only signature GitHub sends: a lowercase hex HMAC-SHA256. */
const SIGNATURE = /^sha256=[0-9a-f]{64}$/;

const tooLarge = () => Response.json({ error: "too large" }, { status: 413 });

/** The body's bytes, or undefined once it runs past `max`. A chunked upload declares no length, so it is counted as it streams. */
async function readBody(request: Request, max: number): Promise<Uint8Array | undefined> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, length);
}

export async function POST(request: Request): Promise<Response> {
  // The signature covers the whole body, so it has to be read; anything that cannot be a delivery is refused first.
  const signature = request.headers.get("x-hub-signature-256");
  if (!signature || !SIGNATURE.test(signature)) return Response.json({ error: "invalid signature" }, { status: 401 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BYTES) return tooLarge();
  const bytes = await readBody(request, MAX_BYTES);
  if (!bytes) return tooLarge();
  // Verify against the exact bytes GitHub signed, before parsing anything.
  if (!verifySignature(config().GITHUB_WEBHOOK_SECRET, bytes, signature)) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  const body = new TextDecoder().decode(bytes);
  const event = request.headers.get("x-github-event");
  const delivery = request.headers.get("x-github-delivery");
  if (!event || !delivery) return Response.json({ error: "missing event headers" }, { status: 400 });

  try {
    const outcome = await handleWebhook({ db: db(), github: githubApp(), startScan, startInventory, canScan: billingEnabled() ? canScan : undefined }, event, delivery, JSON.parse(body));
    return Response.json(outcome, { status: 202 });
  } catch (error) {
    // Logged by delivery id and error class only: the payload and the error's message can include code and user data.
    console.error(`Webhook ${delivery} (${event}) failed: ${describeError(error)}`);
    await captureException(error, { source: "webhook", tags: { event: webhookEventTag(event) } });
    return Response.json({ error: "handling failed" }, { status: 500 });
  }
}
