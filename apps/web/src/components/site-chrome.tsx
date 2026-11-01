/**
 * The public site's header and footer, shared by the landing page, the docs
 * and the legal pages so their navigation stays the same. Server components:
 * no JavaScript.
 */
import { isDraftLegalLink } from "@/lib/legal";
import { brandAsset, site } from "@/lib/site";

const NAV = [
  { id: "docs", label: "Docs", href: site.links.docs },
  { id: "github", label: "GitHub", href: site.githubUrl },
] as const;

const FOOTER = [
  { id: "docs", label: "Docs", href: site.links.docs },
  { id: "github", label: "GitHub", href: site.githubUrl },
  { id: "terms", label: "Terms", href: site.links.terms },
  { id: "privacy", label: "Privacy", href: site.links.privacy },
  { id: "acceptable-use", label: "Acceptable use", href: site.links.acceptableUse },
] as const;

type Section = (typeof FOOTER)[number]["id"];

export function SiteHeader({ current }: { current?: Section }) {
  return (
    <header className="site-header">
      <a href="/" className="wordmark" aria-label="Sandchest home">
        <img src={brandAsset("/sandchest-logo-dark.svg")} alt="Sandchest" width={184} height={34} />
      </a>
      <nav aria-label="Main" className="header-nav">
        {NAV.map((link) => (
          <a key={link.id} href={link.href} aria-current={link.id === current ? "page" : undefined}>
            {link.label}
          </a>
        ))}
      </nav>
    </header>
  );
}

export function SiteFooter({ current }: { current?: Section }) {
  return (
    <footer className="site-footer">
      <nav aria-label="Footer">
        <ul>
          {/* Legal pages stay unlinked while they still hold placeholders (lib/legal.ts). */}
          {FOOTER.filter((link) => !isDraftLegalLink(link.href)).map((link) => (
            <li key={link.id}>
              <a href={link.href} aria-current={link.id === current ? "page" : undefined}>
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <p>Open source under AGPL-3.0.</p>
    </footer>
  );
}
