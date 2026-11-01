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
import { site } from "./site";

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

/** Where a page's Markdown is served: /docs.md, /docs/<page>.md. */
export function markdownUrl(page: Pick<DocsPage, "url">): string {
  return `${page.url}.md`;
}

/**
 * A page as one Markdown document: title, summary, then the body as written,
 * with site links made absolute so the Markdown works wherever it is pasted.
 */
export async function pageMarkdown(page: DocsPage): Promise<string> {
  const base = site.url.replace(/\/$/, "");
  const body = (await page.data.getText("processed")).trim().replace(/\]\(\/(?!\/)/g, `](${base}/`);
  const summary = page.data.description ? `\n\n> ${page.data.description}` : "";
  return `# ${page.data.title}${summary}\n\n${body}\n`;
}

/** `/llms.txt`: what Sandchest is, and every docs page as a link to its Markdown. */
export async function llmsIndex(): Promise<string> {
  const base = site.url.replace(/\/$/, "");
  const pages = await docsInOrder();
  return [
    `# ${site.name}`,
    "",
    "> Sandchest is an open-source GitHub App that reads your code the way an attacker would, finds exploitable vulnerabilities, and gives you a fix prompt for your coding agent.",
    "",
    `Each page below is Markdown; drop the \`.md\` for the web page. Every page in one file: ${base}/llms-full.txt`,
    "",
    "## Docs",
    "",
    ...pages.map((page) => `- [${page.data.title}](${base}${markdownUrl(page)})${page.data.description ? `: ${page.data.description}` : ""}`),
    "",
    "## Policies",
    "",
    `- [Terms of service](${base}${site.links.terms})`,
    `- [Privacy policy](${base}${site.links.privacy})`,
    `- [Acceptable use policy](${base}${site.links.acceptableUse})`,
    "",
  ].join("\n");
}

/** `/llms-full.txt`: every docs page, in sidebar order, as Markdown. */
export async function llmsFull(): Promise<string> {
  const pages = await Promise.all((await docsInOrder()).map(pageMarkdown));
  return pages.join("\n---\n\n");
}

export type LegalSlug = "terms" | "privacy" | "acceptable-use";

export async function legalPage(slug: LegalSlug) {
  const page = (await legalCollection).find((entry) => entry.info.path === `${slug}.mdx`);
  if (!page) throw new Error(`Missing legal page content/legal/${slug}.mdx`);
  return page;
}
