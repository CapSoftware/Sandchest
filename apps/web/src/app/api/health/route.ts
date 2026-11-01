/**
 * For health checks: 200 when the settings are usable and the database
 * answers, 503 otherwise. Says nothing about which.
 */
import { db } from "@/server/db";
import { configurationProblem } from "@/server/readiness";
import { setupNeeded } from "@/server/setup";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (configurationProblem()) return Response.json({ ok: false }, { status: 503, headers });
  // Before setup there is no full configuration, and so no database handle, to check.
  if (!setupNeeded()) {
    const reachable = await db()
      .$client`select 1`
      .then(() => true)
      .catch(() => false);
    if (!reachable) return Response.json({ ok: false }, { status: 503, headers });
  }
  return Response.json({ ok: true }, { headers });
}
