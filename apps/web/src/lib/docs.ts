/**
 * The docs (content/docs) and legal pages (content/legal), compiled by
 * fumadocs-mdx at build time. Server-only: pages import this, the browser
 * never does.
 *
 * The generated index exports promises (see source.config.ts), so everything
 * here is async and nothing is awaited at module level.
 */
import { docs as docsCollection, legal as legalCollection } from "collections/collections";
import type { Item, Node } from "fumadocs-core/page-tree";
import { loader } from "fumadocs-core/source";
import { joinPages, renderLlmsIndex, renderPageMarkdown } from "./llms";
import { site } from "./site";

export { markdownUrl } from "./llms";

const createLoader = async () => loader({ baseUrl: "/docs", source: (await docsCollection).toFumadocsSource() });

let cached: ReturnType<typeof createLoader> | undefined;

export function getDocs() {
  return (cached ??= createLoader());
}

type Docs = Awaited<ReturnType<typeof getDocs>>;
export type DocsPage = NonNullable<ReturnType<Docs["getPage"]>>;

export async function getDocsPage(slug: string[] | undefined): Promise<DocsPage | undefined> {
  return (await getDocs()).getPage(slug);
}

export async function docsParams(): Promise<Array<{ slug: string[] }>> {
  return (await getDocs()).generateParams();
}

/** Docs pages in sidebar order (content/docs/meta.json). */
export async function docsInOrder(): Promise<DocsPage[]> {
  const docs = await getDocs();
  const flatten = (nodes: Node[]): Item[] =>
    nodes.flatMap((node) => (node.type === "page" ? [node] : node.type === "folder" ? [...(node.index ? [node.index] : []), ...flatten(node.children)] : []));
  return flatten(docs.pageTree.children)
    .map((item) => docs.getNodePage(item))
    .filter((page): page is DocsPage => page !== undefined);
}

const summary = (page: DocsPage) => ({ url: page.url, title: page.data.title, description: page.data.description });

export async function pageMarkdown(page: DocsPage): Promise<string> {
  return renderPageMarkdown(summary(page), await page.data.getText("processed"), site.url);
}

export async function llmsIndex(): Promise<string> {
  return renderLlmsIndex((await docsInOrder()).map(summary), site.url);
}

export async function llmsFull(): Promise<string> {
  return joinPages(await Promise.all((await docsInOrder()).map(pageMarkdown)));
}

export type LegalSlug = "terms" | "privacy" | "acceptable-use";

export async function legalPage(slug: LegalSlug) {
  const page = (await legalCollection).find((entry) => entry.info.path === `${slug}.mdx`);
  if (!page) throw new Error(`Missing legal page content/legal/${slug}.mdx`);
  return page;
}
