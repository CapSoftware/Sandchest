"use client";
import { HoverLink } from "./hover-link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/repos", label: "Repos" },
  { href: "/findings", label: "Findings" },
  { href: "/settings", label: "Settings" },
];

export function AppNav({ admin = false }: { admin?: boolean }) {
  const path = usePathname();
  // A scan belongs to its repo, so it lights Repos. The admin pages are served from /ops.
  const section = path.startsWith("/scans") ? "/repos" : path.startsWith("/ops") ? "/admin" : path;
  const links = admin ? [...LINKS, { href: "/admin", label: "Admin" }] : LINKS;
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
