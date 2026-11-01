"use client";
import { HoverLink } from "./hover-link";
import { usePathname } from "next/navigation";

/** The dashboard's sections. The links come from the server, so the client code names no section it was not given. */
export function AppNav({ links }: { links: ReadonlyArray<{ href: string; label: string }> }) {
  const path = usePathname();
  // A scan belongs to its repo, so it lights Repos.
  const section = path.startsWith("/scans") ? "/repos" : path;
  return (
    <nav className="app-nav" aria-label="Main">
      {links.map((link) => (
        <HoverLink key={link.href} href={link.href} aria-current={section.startsWith(link.href) ? "page" : undefined}>
          {link.label}
        </HoverLink>
      ))}
    </nav>
  );
}
