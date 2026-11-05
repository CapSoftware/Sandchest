/**
 * Follows OSV's change feeds once a minute, run by Vercel Cron: a new or
 * changed advisory reaches every repository installing the package within a
 * minute of OSV publishing it (see `followFeeds`).
 */
import { fromCron } from "@/server/cron";
import { followFeeds } from "@/server/cves";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!fromCron(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const result = await followFeeds();
  return Response.json("skipped" in result ? result : { changed: result.changed, packages: result.packages, added: result.added.length, errors: result.errors.length });
}
