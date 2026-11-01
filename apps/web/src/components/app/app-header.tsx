import Link from "next/link";
import { Avatar } from "@/components/app/avatar";
import { AppNav } from "@/components/app/nav";
import type { Viewer } from "@/server/access";

const SECTIONS = [
  { href: "/dashboard", label: "Repos" },
  { href: "/dashboard/findings", label: "Findings" },
  { href: "/dashboard/settings", label: "Settings" },
];

/** The sections a person sees: operators also get Admin. Decided here, on the server. */
export function navLinks(admin: boolean): Array<{ href: string; label: string }> {
  return admin ? [...SECTIONS, { href: "/admin", label: "Admin" }] : SECTIONS;
}

/** The dashboard's header: mark, sections and the signed-in person. */
export function AppHeader({ user, admin }: { user: Viewer; admin: boolean }) {
  return (
    <header className="app-header">
      <div className="shell">
        <Link href="/dashboard" className="app-mark" aria-label="Sandchest">
          <img src="/sandchest-icon-small.svg" alt="" width={30} height={28} />
        </Link>
        <AppNav links={navLinks(admin)} />
        <div className="app-user">
          <span className="app-user-name">{user.login ?? user.name}</span>
          <Avatar src={user.image} />
        </div>
      </div>
    </header>
  );
}
