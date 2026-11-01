/**
 * The frame around docs and legal pages: the site header and footer, and for
 * docs a sidebar. On a phone the sidebar is replaced by a popover opened by a
 * button, which needs no JavaScript. The two are separate elements, each
 * hidden on the other's screen size, so an open popover can never be left
 * drawing over a desktop layout.
 */
import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import type { DocsPage } from "@/lib/docs";

function DocsLinks({ pages, current }: { pages: DocsPage[]; current: DocsPage }) {
  return (
    <>
      <p className="docs-nav-title">Docs</p>
      <ol>
        {pages.map((page) => (
          <li key={page.url}>
            <a href={page.url} aria-current={page.url === current.url ? "page" : undefined}>
              {page.data.title}
            </a>
          </li>
        ))}
      </ol>
    </>
  );
}

export function DocsShell({ pages, current, children }: { pages: DocsPage[]; current: DocsPage; children: ReactNode }) {
  return (
    <div className="docs-frame">
      <SiteHeader current="docs" />
      <div className="docs-body">
        <div className="docs-menu-bar">
          <button type="button" className="docs-key" popoverTarget="docs-menu">
            <span className="docs-key-face">
              <MenuIcon />
              Menu
            </span>
          </button>
          <span className="docs-menu-current">{current.data.title}</span>
        </div>
        <nav id="docs-menu" className="docs-menu" aria-label="Docs" popover="auto">
          <DocsLinks pages={pages} current={current} />
          <button type="button" className="docs-menu-close" popoverTarget="docs-menu" popoverTargetAction="hide">
            Close
          </button>
        </nav>
        <nav className="docs-sidebar" aria-label="Docs">
          <DocsLinks pages={pages} current={current} />
        </nav>
        <main className="docs-main">{children}</main>
      </div>
      <SiteFooter current="docs" />
    </div>
  );
}

export function LegalShell({ current, children }: { current: "terms" | "privacy" | "acceptable-use"; children: ReactNode }) {
  return (
    <div className="docs-frame">
      <SiteHeader />
      <main className="legal-main">{children}</main>
      <SiteFooter current={current} />
    </div>
  );
}

/** Three pixel bars. */
function MenuIcon() {
  return (
    <svg className="docs-key-icon" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true" shapeRendering="crispEdges">
      <rect x="0" y="1" width="8" height="1" />
      <rect x="0" y="3.5" width="8" height="1" />
      <rect x="0" y="6" width="8" height="1" />
    </svg>
  );
}
