/** The landing crawl's feed: new public advisories, and Sandchest's newest findings reduced to severity and kind. Public. */
import { FEED_TTL_S, liveFeed } from "@/server/feed";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    // One copy for everyone: the CDN keeps it for ten minutes and serves the last one while it refreshes.
    return Response.json(await liveFeed(), {
      headers: { "cache-control": `public, max-age=60, s-maxage=${FEED_TTL_S}, stale-while-revalidate=${FEED_TTL_S * 6}` },
    });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
