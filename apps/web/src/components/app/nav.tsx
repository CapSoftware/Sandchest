"use client";
import { HoverLink } from "./hover-link";
import { usePathname } from "next/navigation";
import { NavIcon } from "./nav-icons";

/** The hacker's own page: lit by the hacker's name in the header, not by a section. */
export const HACKER_PATH = "/dashboard/hacker";

/**
 * The dashboard's sections. The links come from the server, so the client code names no section it was not given.
 * A row of words in the header on wide screens; on a phone, a tab bar along the foot of the screen, each with its icon.
 */
export function AppNav({ links }: { links: ReadonlyArray<{ href: string; label: string }> }) {
  const path = usePathname();
  const current = path === HACKER_PATH || path.startsWith(`${HACKER_PATH}/`) ? undefined : currentSection(path, links);
  return (
    <nav className="app-nav" aria-label="Main">
      {links.map((link) => (
        <HoverLink key={link.href} href={link.href} aria-current={link.href === current ? "page" : undefined}>
          <NavIcon href={link.href} />
          <span className="app-nav-label">{link.label}</span>
        </HoverLink>
      ))}
    </nav>
  );
}

/**
 * The one section a path belongs to: the longest link it sits under, whole
 * segments only. Every section lives under /dashboard (Overview itself), so
 * pages without a section of their own (billing, recruiting) light Overview.
 */
export function currentSection(path: string, links: ReadonlyArray<{ href: string }>): string | undefined {
  const under = (href: string) => path === href || path.startsWith(`${href}/`);
  return links.reduce<string | undefined>((best, { href }) => (under(href) && href.length > (best?.length ?? -1) ? href : best), undefined);
}
