/**
 * The Markdown the docs are served as: each page at /docs/<page>.md, all of
 * them in /llms-full.txt, and the /llms.txt index. Pure functions, so tests
 * can check them without compiling MDX.
 */
import { isDraftLegalLink, legalDraft } from "./legal";
import { site } from "./site";

export interface MarkdownPage {
  url: string;
  title: string;
  description?: string;
}

/** Where a page's Markdown is served: /docs.md, /docs/<page>.md. */
export function markdownUrl(page: Pick<MarkdownPage, "url">): string {
  return `${page.url}.md`;
}

/**
 * A page as one Markdown document: title, summary, then the body as written.
 * Site links become absolute so the Markdown works wherever it is pasted;
 * links to draft legal pages become plain text.
 */
export function renderPageMarkdown(page: MarkdownPage, body: string, base: string, draft = legalDraft): string {
  const text = body
    .trim()
    .replace(/\[([^\]]*)\]\((\/[^)\s]*)\)/g, (link, label: string, href: string) => {
      if (href.startsWith("//")) return link;
      return isDraftLegalLink(href, draft) ? label : `[${label}](${base}${href})`;
    });
  const summary = page.description ? `\n\n> ${page.description}` : "";
  return `# ${page.title}${summary}\n\n${text}\n`;
}

/** `/llms.txt`: what Sandchest is, and every docs page as a link to its Markdown. */
export function renderLlmsIndex(pages: MarkdownPage[], base: string, draft = legalDraft): string {
  const policies = draft
    ? []
    : ["## Policies", "", `- [Terms of service](${base}${site.links.terms})`, `- [Privacy policy](${base}${site.links.privacy})`, `- [Acceptable use policy](${base}${site.links.acceptableUse})`, ""];
  return [
    `# ${site.name}`,
    "",
    "> Sandchest is an open-source GitHub App that reads your code the way an attacker would, finds exploitable vulnerabilities, and gives you a fix prompt for your coding agent.",
    "",
    `Each page below is Markdown; drop the \`.md\` for the web page. Every page in one file: ${base}/llms-full.txt`,
    "",
    "## Docs",
    "",
    ...pages.map((page) => `- [${page.title}](${base}${markdownUrl(page)})${page.description ? `: ${page.description}` : ""}`),
    "",
    ...policies,
  ].join("\n");
}

/** `/llms-full.txt`: rendered pages, in order. */
export function joinPages(pages: string[]): string {
  return pages.join("\n---\n\n");
}
