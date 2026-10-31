import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { record } from "@/lib/audit";
import { handle, requireOrgRole, requireSession } from "@/lib/auth";
import { query } from "@/lib/db";
import type { Webhook } from "@/lib/types";
import { assertPublicUrl, newWebhookSecret } from "@/lib/webhooks";

const EVENTS = ["invoice.created", "invoice.paid", "invoice.voided"] as const;
const NewWebhook = z.object({ url: z.string().url(), events: z.array(z.enum(EVENTS)).min(1) });

export const GET = handle(async (request: NextRequest) => {
  const session = requireSession(request);
  const hooks = await query<Omit<Webhook, "secret">>("SELECT id, org_id, url, events, active FROM webhooks WHERE org_id = $1", [session.orgId]);
  return NextResponse.json({ webhooks: hooks });
});

export const POST = handle(async (request: NextRequest) => {
  const session = requireSession(request);
  requireOrgRole(session, ["owner", "admin"]);
  const parsed = NewWebhook.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const url = await assertPublicUrl(parsed.data.url);
  const [hook] = await query<Webhook>(
    "INSERT INTO webhooks (org_id, url, secret, events, active) VALUES ($1, $2, $3, $4, true) RETURNING *",
    [session.orgId, url.toString(), newWebhookSecret(), parsed.data.events],
  );
  await record(session.orgId, session.userId, "webhook.create", hook!.id, { url: url.host });
  return NextResponse.json({ webhook: hook }, { status: 201 });
});
