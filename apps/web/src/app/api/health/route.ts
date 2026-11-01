/**
 * For health checks: 200 when the settings are usable and the database
 * answers, setup mode included, and 503 otherwise. Says nothing about which.
 */
import { healthy } from "@/server/health";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const ok = await healthy();
  return Response.json({ ok }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
