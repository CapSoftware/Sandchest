import type { Metadata } from "next";
import { legalPage, type LegalSlug } from "@/lib/docs";
import { legal } from "@/lib/legal";
import { site } from "@/lib/site";
import { mdxComponents } from "./mdx";
import { LegalShell } from "./shell";

export async function legalMetadata(slug: LegalSlug): Promise<Metadata> {
  const page = await legalPage(slug);
  return { title: `${page.title} · ${site.name}`, description: page.description, alternates: { canonical: `/${slug}` } };
}

/** One of the legal pages (content/legal/<slug>.mdx). Their facts come from lib/legal.ts. */
export async function LegalPage({ slug }: { slug: LegalSlug }) {
  const page = await legalPage(slug);
  const Body = page.body;
  return (
    <LegalShell current={slug}>
      <article className="prose">
        <header className="docs-head">
          <h1 className="docs-title">{page.title}</h1>
          {page.description && <p className="docs-lede">{page.description}</p>}
          <p className="legal-updated">Last updated {legal.lastUpdated}</p>
        </header>
        <Body components={mdxComponents} />
      </article>
    </LegalShell>
  );
}
