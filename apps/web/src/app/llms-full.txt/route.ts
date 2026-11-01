/** Every docs page in one Markdown file, in sidebar order. */
import { llmsFull } from "@/lib/docs";

export const dynamic = "force-static";

export async function GET() {
  return new Response(await llmsFull(), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
