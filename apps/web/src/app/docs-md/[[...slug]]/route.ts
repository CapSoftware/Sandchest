/** A docs page as Markdown. Served at /docs.md and /docs/<page>.md (rewrites in next.config.ts). */
import { notFound } from "next/navigation";
import { docsParams, getDocsPage, pageMarkdown } from "@/lib/docs";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return docsParams();
}

export async function GET(_request: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const page = await getDocsPage((await params).slug);
  if (!page) notFound();
  return new Response(await pageMarkdown(page), {
    // The web page is the one search engines should list.
    headers: { "content-type": "text/markdown; charset=utf-8", "x-robots-tag": "noindex" },
  });
}
