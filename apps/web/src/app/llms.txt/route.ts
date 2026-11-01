/** The llms.txt index: every docs page as a link to its Markdown. */
import { llmsIndex } from "@/lib/docs";

export const dynamic = "force-static";

export async function GET() {
  return new Response(await llmsIndex(), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
