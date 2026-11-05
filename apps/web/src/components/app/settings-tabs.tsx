"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useDashboardPath, useDemo } from "./demo";
import { HoverLink } from "./hover-link";

const BASE = "/dashboard/settings";

/** Settings' tabs. Billing shows only where billing is on. */
export function settingsTabs(billing: boolean): Array<{ href: string; label: string }> {
  return [
    { href: BASE, label: "General" },
    { href: `${BASE}/team`, label: "Team" },
    ...(billing ? [{ href: `${BASE}/billing`, label: "Billing" }] : []),
    { href: `${BASE}/repositories`, label: "Repositories" },
    { href: `${BASE}/agents`, label: "Agents" },
    { href: `${BASE}/account`, label: "Account" },
  ];
}

/** Where links from before the tabs (emails, Checks, other pages) pointed by anchor. */
const LEGACY: Record<string, string> = { "#billing": `${BASE}/billing`, "#agents": `${BASE}/agents`, "#team": `${BASE}/team` };

export function SettingsTabs({ billing }: { billing: boolean }) {
  const path = useDashboardPath();
  const router = useRouter();
  const demo = useDemo();
  // An old link to /dashboard/settings#billing lands on its tab, with the rest of its URL (utm tags) kept.
  useEffect(() => {
    const to = !demo && path === BASE ? LEGACY[window.location.hash] : undefined;
    if (to) router.replace(`${to}${window.location.search}`);
  }, [demo, path, router]);
  return (
    <nav className="settings-tabs" aria-label="Settings">
      {settingsTabs(billing).map((tab) => (
        <HoverLink key={tab.href} href={tab.href} aria-current={path === tab.href ? "page" : undefined}>
          {tab.label}
        </HoverLink>
      ))}
    </nav>
  );
}
