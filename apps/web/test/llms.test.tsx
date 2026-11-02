/**
 * How the docs are served as Markdown: the /docs/<page>.md rewrites, each
 * page's Markdown, llms.txt and llms-full.txt, and the legal pages staying
 * out of sight while they hold placeholders.
 */
import { describe, expect, test } from "bun:test";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mdxComponents } from "@/components/docs/mdx";
import { SiteFooter } from "@/components/site-chrome";
import { markdownRewrites } from "@/lib/docs-routes";
import { isDraftLegalLink, isPlaceholder, legal, legalDraft, legalRobots } from "@/lib/legal";
import { joinPages, markdownBase, markdownUrl, renderLlmsIndex, renderPageMarkdown } from "@/lib/llms";
import { site, siteUrl } from "@/lib/site";

const base = "https://sandchest.example";
const pages = [
  { url: "/docs", title: "Getting started", description: "Install it." },
  { url: "/docs/pricing", title: "Pricing & credits", description: "What it costs." },
];

describe("Markdown URLs", () => {
  /** Where Next sends a path, using Next's own matcher on our rewrites. */
  function rewrite(path: string): { destination: string; params: Record<string, unknown> } | undefined {
    for (const rule of markdownRewrites) {
      const params = getPathMatch(rule.source)(path);
      if (params) return { destination: rule.destination, params };
    }
  }

  test("each page's .md goes to the docs-md route with its slug", () => {
    expect(rewrite("/docs.md")).toEqual({ destination: "/docs-md", params: {} });
    expect(rewrite("/docs/pricing.md")).toEqual({ destination: "/docs-md/:path*", params: { path: ["pricing"] } });
    expect(rewrite("/docs/a/b.md")?.params).toEqual({ path: ["a", "b"] });
  });

  test("web pages and other files are left alone", () => {
    for (const path of ["/docs", "/docs/pricing", "/docs/pricing.mdx", "/terms.md", "/llms.txt"]) expect(rewrite(path), path).toBeUndefined();
  });

  test("markdownUrl matches the rewrites", () => {
    for (const page of pages) expect(rewrite(markdownUrl(page))).toBeDefined();
  });
});

describe("page Markdown", () => {
  const body = "See [pricing](/docs/pricing#top-ups), [GitHub](https://github.com), [protocol-relative](//cdn.example) and [the policy](/privacy#contact).";

  test("starts with the title and summary, and makes site links absolute", () => {
    const markdown = renderPageMarkdown(pages[1]!, `\n${body}\n`, base, false);
    expect(markdown).toBe(
      `# Pricing & credits\n\n> What it costs.\n\nSee [pricing](${base}/docs/pricing#top-ups), [GitHub](https://github.com), [protocol-relative](//cdn.example) and [the policy](${base}/privacy#contact).\n`,
    );
  });

  test("links to draft legal pages become plain text", () => {
    expect(renderPageMarkdown(pages[1]!, body, base, true)).toContain("and the policy.");
  });
});

describe("llms.txt and llms-full.txt", () => {
  test("the index links every page's Markdown, in order", () => {
    const index = renderLlmsIndex(pages, base, false);
    expect(index.startsWith("# Sandchest\n\n> ")).toBe(true);
    const links = [...index.matchAll(/^- \[([^\]]+)\]\(([^)]+)\)/gm)].map((m) => [m[1], m[2]]);
    expect(links.slice(0, 2)).toEqual([
      ["Getting started", `${base}/docs.md`],
      ["Pricing & credits", `${base}/docs/pricing.md`],
    ]);
    expect(index).toContain(`${base}/llms-full.txt`);
    expect(index).toContain(`[Privacy policy](${base}/privacy)`);
  });

  test("the index leaves out draft legal pages", () => {
    const index = renderLlmsIndex(pages, base, true);
    expect(index).not.toContain("## Policies");
    expect(index).not.toMatch(/\/(terms|privacy|acceptable-use)\b/);
  });

  test("the full file is every page, separated by rules", () => {
    expect(joinPages(["# A\n", "# B\n"])).toBe("# A\n\n---\n\n# B\n");
  });
});

describe("links without a known address", () => {
  test("a build that knows its address writes absolute links", () => {
    expect(markdownBase({ NEXT_PUBLIC_SITE_URL: "https://www.example.com" })).toBe("https://www.example.com");
    expect(markdownBase({ VERCEL_PROJECT_PRODUCTION_URL: "www.example.com" })).toBe("https://www.example.com");
  });

  test("a build that doesn't (a self-hosted image) writes root-relative links, never localhost", () => {
    const base = markdownBase({});
    expect(base).toBe("");
    const index = renderLlmsIndex(pages, base, false);
    const markdown = renderPageMarkdown(pages[1]!, "See [scans](/docs/scans#fix-checks) and [the policy](/privacy).", base, false);
    for (const output of [index, markdown]) expect(output).not.toContain("localhost");
    expect(index).toContain("- [Getting started](/docs.md)");
    expect(index).toContain("- [Pricing & credits](/docs/pricing.md)");
    expect(index).toContain("Every page in one file: /llms-full.txt");
    expect(index).toContain("[Privacy policy](/privacy)");
    expect(markdown).toContain("See [scans](/docs/scans#fix-checks) and [the policy](/privacy).");
  });
});

describe("site address", () => {
  test("prefers NEXT_PUBLIC_SITE_URL, then Vercel's production domain", () => {
    expect(siteUrl({ NEXT_PUBLIC_SITE_URL: "https://www.example.com/", VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app" })).toBe("https://www.example.com");
    expect(siteUrl({ VERCEL_PROJECT_PRODUCTION_URL: "www.example.com" })).toBe("https://www.example.com");
    expect(siteUrl({})).toBeUndefined();
  });
});

describe("legal pages", () => {
  test("draft legal links are recognised", () => {
    expect(isDraftLegalLink("/privacy#contact", true)).toBe(true);
    expect(isDraftLegalLink("/terms", true)).toBe(true);
    expect(isDraftLegalLink("/privacy", false)).toBe(false);
    expect(isDraftLegalLink("/docs/security", true)).toBe(false);
    expect(isDraftLegalLink("/privacy-policy", true)).toBe(false);
  });

  // While lib/legal.ts holds placeholders, what keeps them from going public is the guard:
  // the pages are noindex and nothing links to them.
  test.skipIf(!legalDraft)("draft legal pages are noindex and unlinked", () => {
    expect(legalRobots()).toEqual({ robots: { index: false, follow: false } });
    for (const href of [site.links.terms, site.links.privacy, site.links.acceptableUse]) expect(isDraftLegalLink(href), href).toBe(true);

    const footer = renderToStaticMarkup(<SiteFooter />);
    expect(footer).toContain('href="/docs"');
    expect(footer).not.toMatch(/href="\/(terms|privacy|acceptable-use)"/);

    const Link = mdxComponents.a as (props: { href: string; children: string }) => ReactElement;
    expect(renderToStaticMarkup(<Link href="/privacy#contact">the policy</Link>)).toBe("the policy");
    expect(renderToStaticMarkup(<Link href="/docs/security">security</Link>)).toBe('<a href="/docs/security">security</a>');

    expect(renderLlmsIndex(pages, base)).not.toMatch(/\/(terms|privacy|acceptable-use)\b/);
    expect(renderPageMarkdown(pages[1]!, "[the policy](/privacy)", base)).not.toContain("/privacy");
  });

  test.skipIf(legalDraft)("published legal pages are linked from the footer, which credits Cap", () => {
    expect(legalRobots()).toEqual({});
    const footer = renderToStaticMarkup(<SiteFooter current="terms" />);
    for (const href of [site.links.terms, site.links.privacy, site.links.acceptableUse]) expect(footer).toContain(`href="${href}"`);
    expect(footer).toContain('href="/terms" aria-current="page"');
    expect(footer).toContain(`href="${site.parent.url}"`);
    expect(footer).toContain(legal.entity);
  });

  // Before launch: SANDCHEST_LEGAL_FINAL=1 bun test fails until every placeholder is replaced.
  test.skipIf(process.env.SANDCHEST_LEGAL_FINAL !== "1")("every legal fact is filled in", () => {
    const missing = Object.entries(legal)
      .filter(([, value]) => isPlaceholder(value))
      .map(([key]) => key);
    expect(missing).toEqual([]);
    expect(legalDraft).toBe(false);
  });
});
