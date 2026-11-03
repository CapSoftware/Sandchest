import type { Viewport } from "next";
import type { ReactNode } from "react";
import { after } from "next/server";
import { recordDailyVisit } from "@sandchest/db";
import { AppHeader } from "@/components/app/app-header";
import { SessionKeepAlive } from "@/components/app/session-keepalive";
import { Skeletons } from "@/components/app/skeleton";
import { currentUser } from "@/server/access";
import { isAdmin } from "@/server/admin";
import { db } from "@/server/db";
import { sessionRefreshDue } from "@/server/session-token";
import { redirect } from "next/navigation";
import "../app.css";

/** Edge to edge on phones with a notch: the tab bar and the shell keep clear of it themselves (safe-area insets). */
export const viewport: Viewport = { viewportFit: "cover" };

/** People already recorded as visiting today by this server instance, so most page views write nothing. */
const visited = new Map<string, string>();

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Pages check access themselves; this only decides whether to show the frame.
  const user = await currentUser();
  if (!user) redirect("/sign-in");
  // A daily visit, for the funnel's retention steps. Written after the response; never slows the page.
  const today = new Date().toISOString().slice(0, 10);
  if (visited.get(user.id) !== today) {
    if (visited.size > 10_000) visited.clear();
    visited.set(user.id, today);
    after(() => recordDailyVisit(db(), user.id).catch(() => visited.delete(user.id)));
  }
  return (
    <Skeletons>
      {sessionRefreshDue(user.sessionExpiresAt) && <SessionKeepAlive />}
      <AppHeader user={user} admin={isAdmin(user)} />
      <main className="app-main shell">{children}</main>
    </Skeletons>
  );
}
