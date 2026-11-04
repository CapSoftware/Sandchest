import { deliveryHeaders, verifySignature } from "@sandchest/forgejo";
import { describeError } from "@/server/log";
import { forgejoDeps } from "@/server/forgejo-sync";
import { handleForgejoWebhook } from "@/server/forgejo-webhooks";
import { captureException, webhookEventTag } from "@/server/sentry";

export const dynamic = "force-dynamic";

/** Forgejo and Gitea deliveries. Without FORGEJO_URL there is nothing here. */
export async function POST(request: Request): Promise<Response> {
  const deps = forgejoDeps();
  if (!deps) return Response.json({ error: "not found" }, { status: 404 });
  // Verify against the exact bytes Forgejo signed, before parsing anything.
  const body = await request.text();
  const { event, delivery, signature } = deliveryHeaders(request.headers);
  if (!verifySignature(deps.forgejo.config.webhookSecret, body, signature)) return Response.json({ error: "invalid signature" }, { status: 401 });
  if (!event || !delivery) return Response.json({ error: "missing event headers" }, { status: 400 });

  try {
    const outcome = await handleForgejoWebhook(deps, event, delivery, JSON.parse(body));
    return Response.json(outcome, { status: 202 });
  } catch (error) {
    // Logged by delivery id and error class only: the payload and the error's message can include code and user data.
    console.error(`Forgejo webhook ${delivery} (${event}) failed: ${describeError(error)}`);
    await captureException(error, { source: "webhook", tags: { event: webhookEventTag(event) } });
    return Response.json({ error: "handling failed" }, { status: 500 });
  }
}
