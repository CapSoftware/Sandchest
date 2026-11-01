"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/repos", label: "Repos" },
  { href: "/findings", label: "Findings" },
  { href: "/settings", label: "Settings" },
];

export function AppNav() {
  const path = usePathname();
  // A scan belongs to its repo, so it lights Repos.
  const section = path.startsWith("/scans") ? "/repos" : path;
  return (
    <nav className="app-nav" aria-label="Main">
      {LINKS.map((link) => (
        <Link key={link.href} href={link.href} aria-current={section.startsWith(link.href) ? "page" : undefined}>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
