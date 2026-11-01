import Link from "next/link";
import { Avatar } from "@/components/app/avatar";
import { AppNav } from "@/components/app/nav";
import type { Viewer } from "@/server/access";

/** The dashboard's header: mark, sections and the signed-in person. Operators also see Admin. */
export function AppHeader({ user, admin }: { user: Viewer; admin: boolean }) {
  return (
    <header className="app-header">
      <div className="shell">
        <Link href="/repos" className="app-mark" aria-label="Sandchest">
          <img src="/sandchest-icon-small.svg" alt="" width={30} height={28} />
        </Link>
        <AppNav admin={admin} />
        <div className="app-user">
          <span className="app-user-name">{user.login ?? user.name}</span>
          <Avatar src={user.image} />
        </div>
      </div>
    </header>
  );
}
