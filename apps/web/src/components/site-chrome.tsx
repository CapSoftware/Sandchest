/**
 * The public site's header and footer, shared by the landing page, the docs
 * and the legal pages so their navigation stays the same. Server components:
 * no JavaScript.
 */
import { isDraftLegalLink, legal } from "@/lib/legal";
import { brandAsset, site } from "@/lib/site";

const NAV = [
  { id: "demo", label: "Demo", href: site.links.demo },
  { id: "docs", label: "Docs", href: site.links.docs },
  { id: "github", label: "Open source", href: site.githubUrl },
] as const;

const FOOTER = [
  {
    title: "Product",
    links: [
      { id: "docs", label: "Docs", href: site.links.docs },
      { id: "scans", label: "How scans work", href: site.links.scans },
      { id: "findings", label: "Findings", href: site.links.findings },
      { id: "pricing", label: "Pricing", href: site.links.pricing },
      { id: "agents", label: "Use it from your agent", href: site.links.agents },
    ],
  },
  {
    title: "Open source",
    links: [
      { id: "github", label: "GitHub", href: site.githubUrl },
      { id: "self-hosting", label: "Self-hosting", href: site.links.selfHosting },
      { id: "security", label: "Privacy & security", href: site.links.security },
    ],
  },
  {
    title: "Legal",
    links: [
      { id: "terms", label: "Terms of service", href: site.links.terms },
      { id: "privacy", label: "Privacy policy", href: site.links.privacy },
      { id: "acceptable-use", label: "Acceptable use", href: site.links.acceptableUse },
    ],
  },
] as const;

type Section = (typeof FOOTER)[number]["links"][number]["id"];

/**
 * `visitor` is set only on the landing page, which is built once for each
 * (see `homeRewrites`): signed in, a Dashboard key; otherwise Sign in. Docs
 * and legal pages stay a single static page and show neither.
 */
export function SiteHeader({ current, visitor }: { current?: Section; visitor?: "signed-in" | "signed-out" }) {
  return (
    <header className="site-header">
      <a href="/" className="wordmark" aria-label="Sandchest home">
        <img src={brandAsset("/sandchest-logo-dark.svg")} alt="Sandchest" width={138} height={26} />
      </a>
      <nav aria-label="Main" className="header-nav">
        {NAV.map((link) => (
          <a key={link.id} href={link.href} aria-current={link.id === current ? "page" : undefined}>
            {link.label}
          </a>
        ))}
        {visitor === "signed-out" && (
          <a href={site.links.signIn} data-track="nav-sign-in">
            Sign in
          </a>
        )}
        {visitor === "signed-in" && (
          <a href={site.links.dashboard} className="button button-primary button-small">
            <span className="button-face">Dashboard</span>
          </a>
        )}
      </nav>
    </header>
  );
}

export function SiteFooter({ current }: { current?: Section }) {
  return (
    <footer className="site-footer">
      <div className="footer-top">
        <div className="footer-brand">
          <a href="/" className="footer-mark" aria-label="Sandchest home">
            <img src={brandAsset("/sandchest-icon.svg")} alt="" width={46} height={40} />
          </a>
          <p className="footer-tagline">Add a hacker to your team.</p>
          <p className="footer-blurb">Finds real vulnerabilities in your code, and proves them, before attackers do.</p>
        </div>
        <nav aria-label="Footer" className="footer-columns">
          {FOOTER.map((column) => {
            // Legal pages stay unlinked while they still hold placeholders (lib/legal.ts).
            const links = column.links.filter((link) => !isDraftLegalLink(link.href));
            if (links.length === 0) return null;
            return (
              <div key={column.title} className="footer-column">
                <h2 className="footer-heading">{column.title}</h2>
                <ul>
                  {links.map((link) => (
                    <li key={link.id}>
                      <a href={link.href} aria-current={link.id === current ? "page" : undefined}>
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
      </div>
      <div className="footer-base">
        <p>
          &copy; {new Date().getFullYear()} {legal.entity}
        </p>
        <a href={site.parent.url} className="footer-parent" rel="noreferrer">
          A <CapLogo className="footer-parent-logo" /> company
        </a>
      </div>
    </footer>
  );
}

/** Cap's logo, as Cap's own site header draws it: the glass mark and wordmark, light for a dark page. */
function CapLogo({ className }: { className: string }) {
  return <img className={className} src={brandAsset("/cap-logo.svg")} alt={site.parent.name} width={101} height={40} />;
}
