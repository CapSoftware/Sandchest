import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CopyMarkdown } from "@/components/docs/copy";
import { mdxComponents } from "@/components/docs/mdx";
import { DocsShell } from "@/components/docs/shell";
import { docsInOrder, docsParams, getDocsPage, markdownUrl } from "@/lib/docs";
import { site } from "@/lib/site";

// Every docs page is built ahead of time; anything else is a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return docsParams();
}

type Props = { params: Promise<{ slug?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = await getDocsPage((await params).slug);
  if (!page) notFound();
  const title = page.url === "/docs" ? `Docs · ${site.name}` : `${page.data.title} · ${site.name} docs`;
  return {
    title,
    description: page.data.description,
    alternates: { canonical: page.url, types: { "text/markdown": markdownUrl(page) } },
    openGraph: { title, description: page.data.description, url: page.url },
  };
}

export default async function DocsPage({ params }: Props) {
  const page = await getDocsPage((await params).slug);
  if (!page) notFound();
  const pages = await docsInOrder();
  const index = pages.findIndex((p) => p.url === page.url);
  const previous = pages[index - 1];
  const next = pages[index + 1];
  const Body = page.data.body;

  return (
    <DocsShell pages={pages} current={page}>
      <article className="prose">
        <header className="docs-head">
          <h1 className="docs-title">{page.data.title}</h1>
          {page.data.description && <p className="docs-lede">{page.data.description}</p>}
          <div className="docs-actions">
            <CopyMarkdown href={markdownUrl(page)} />
            <a className="docs-raw" href={markdownUrl(page)}>
              View Markdown
            </a>
          </div>
        </header>
        <Body components={mdxComponents} />
      </article>
      <nav className="docs-pager" aria-label="Previous and next">
        {previous ? (
          <a href={previous.url} rel="prev">
            <span>Previous</span>
            {previous.data.title}
          </a>
        ) : (
          <span />
        )}
        {next ? (
          <a href={next.url} rel="next" className="docs-pager-next">
            <span>Next</span>
            {next.data.title}
          </a>
        ) : null}
      </nav>
    </DocsShell>
  );
}
