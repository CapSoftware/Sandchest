import Link from "next/link";
import type { ReactNode } from "react";
import { Avatar } from "@/components/app/avatar";
import { AppNav } from "@/components/app/nav";
import { currentUser } from "@/server/access";
import { redirect } from "next/navigation";
import "../app.css";

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Pages check access themselves; this only decides whether to show the frame.
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  return (
    <>
      <header className="app-header">
        <div className="shell">
          <Link href="/repos" className="app-mark" aria-label="Sandchest">
            <img src="/sandchest-icon-small.svg" alt="" width={30} height={28} />
          </Link>
          <AppNav />
          <div className="app-user">
            <span className="app-user-name">{user.login ?? user.name}</span>
            <Avatar src={user.image} />
          </div>
        </div>
      </header>
      <main className="app-main shell">{children}</main>
    </>
  );
}
