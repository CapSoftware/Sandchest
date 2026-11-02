import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppHeader } from "@/components/app/app-header";
import { Skeletons } from "@/components/app/skeleton";
import { requireAdmin } from "@/server/admin";
import "../app.css";
import "./admin.css";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The operator dashboards, served at /admin: the proxy rewrites operators
 * here and gives everyone else the ordinary 404 (see `proxy.ts`). Outside the
 * dashboard's route group, which sends signed-out visitors to sign in. The
 * layout and every page check for an operator again all the same.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireAdmin();
  return (
    <Skeletons>
      <AppHeader user={user} admin />
      <main className="app-main shell">{children}</main>
    </Skeletons>
  );
}
