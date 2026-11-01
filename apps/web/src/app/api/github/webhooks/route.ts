import { verifySignature } from "@sandchest/github";
import { billingEnabled, hasPlan } from "@/server/billing";
import { config } from "@/server/config";
import { db, githubApp } from "@/server/services";
import { startScan } from "@/server/start";
import { handleWebhook } from "@/server/webhooks";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Verify against the exact bytes GitHub signed, before parsing anything.
  const body = await request.text();
  if (!verifySignature(config().GITHUB_WEBHOOK_SECRET, body, request.headers.get("x-hub-signature-256"))) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  const event = request.headers.get("x-github-event");
  const delivery = request.headers.get("x-github-delivery");
  if (!event || !delivery) return Response.json({ error: "missing event headers" }, { status: 400 });

  try {
    const outcome = await handleWebhook({ db: db(), github: githubApp(), startScan, hasPlan: billingEnabled() ? hasPlan : undefined }, event, delivery, JSON.parse(body));
    return Response.json(outcome, { status: 202 });
  } catch (error) {
    // Logged without payload contents: they can include code and user data.
    console.error("Webhook handling failed", { event, delivery, error: (error as Error).message });
    return Response.json({ error: "handling failed" }, { status: 500 });
  }
}
