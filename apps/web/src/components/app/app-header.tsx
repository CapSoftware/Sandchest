import Link from "next/link";
import { Suspense } from "react";
import { Avatar } from "@/components/app/avatar";
import { HackerLink } from "@/components/app/hacker-link";
import { AppNav } from "@/components/app/nav";
import { readHacker } from "@/lib/hacker";
import type { Viewer } from "@/server/access";
import { myHackers } from "@/server/hackers";

const SECTIONS = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/scans", label: "Scans" },
  { href: "/dashboard/findings", label: "Findings" },
  { href: "/dashboard/repos", label: "Repos" },
  { href: "/dashboard/settings", label: "Settings" },
];

/** The sections a person sees: operators also get Admin. Decided here, on the server. */
export function navLinks(admin: boolean): Array<{ href: string; label: string }> {
  return admin ? [...SECTIONS, { href: "/admin", label: "Admin" }] : SECTIONS;
}

/** The dashboard's header: mark, sections, the hacker and the signed-in person. */
export function AppHeader({ user, admin }: { user: Viewer; admin: boolean }) {
  return (
    <header className="app-header">
      <div className="shell">
        <Link href="/dashboard" className="app-mark" aria-label="Sandchest">
          <img src="/sandchest-icon-small.svg" alt="" width={30} height={28} />
        </Link>
        <AppNav links={navLinks(admin)} />
        <div className="app-user">
          {/* Streams in after the header, so the header never waits on the query. */}
          <Suspense fallback={<span className="app-hacker app-hacker-pending" aria-hidden="true" />}>
            <HeaderHacker userId={user.id} />
          </Suspense>
          <span className="app-user-name">{user.login ?? user.name}</span>
          <Avatar src={user.image} />
        </div>
      </div>
    </header>
  );
}

/** The person's hacker: the first one they work with (recruited first, then where they're an admin). */
async function HeaderHacker({ userId }: { userId: string }) {
  const [first] = await myHackers(userId).catch(() => []);
  if (!first) return null;
  return <HackerLink profile={readHacker(first.hacker)} working={first.working} />;
}
