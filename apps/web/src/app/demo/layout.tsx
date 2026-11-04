import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { NAV_LINKS } from "@/components/app/app-header";
import { DemoProvider } from "@/components/app/demo";
import { HackerLink } from "@/components/app/hacker-link";
import { AppNav } from "@/components/app/nav";
import { Skeletons } from "@/components/app/skeleton";
import { DEMO_BASE, DEMO_HACKER } from "@/lib/demo";
import { site } from "@/lib/site";
import "../app.css";
import "./demo.css";

export const metadata: Metadata = {
  title: "Demo · Sandchest",
  description: "Click around Sandchest’s dashboard on a made-up account, and watch its hacker run a deep scan.",
};

export const viewport: Viewport = { viewportFit: "cover" };

/**
 * The demo: the dashboard, as anyone can see it without signing in, on a made-up account. Its pages draw the
 * dashboard's own views from `lib/demo.ts`, so they always match the real thing. No database, session or setting
 * is read; it renders per request only so its times stay relative to now.
 */
export default async function DemoLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <Skeletons>
      <DemoProvider base={DEMO_BASE} getStarted={site.links.getStarted}>
        <div className="demo-bar">
          <div className="shell">
            <p>
              <strong>Demo.</strong> <span className="demo-bar-short">A made-up account. Nothing is saved.</span>
              <span className="demo-bar-more">A made-up account, acme. Its deep scan of acme/api replays on a loop, sped up. Nothing here is real or saved.</span>
            </p>
            <a href="/" className="demo-bar-home">
              Back to the site
            </a>
          </div>
        </div>
        <header className="app-header">
          <div className="shell">
            <Link href={DEMO_BASE} className="app-mark" aria-label="Sandchest demo">
              <img src="/sandchest-icon-small.svg" alt="" width={30} height={28} />
            </Link>
            <AppNav links={NAV_LINKS} />
            <div className="app-user">
              <HackerLink profile={DEMO_HACKER} working />
              <a href={site.links.getStarted} className="key key-primary demo-start" data-track="demo-get-started">
                <span className="key-face">Get started</span>
              </a>
            </div>
          </div>
        </header>
        <main className="app-main shell">{children}</main>
      </DemoProvider>
    </Skeletons>
  );
}
