import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Recruit } from "@/components/recruit/recruit";
import { currentUser } from "@/server/access";
import { signIn } from "@/server/actions";
import { signInProviders } from "@/server/auth";
import { billingEnabled } from "@/server/billing";
import { claimIntent } from "@/server/free-credits";
import { setupNeeded } from "@/server/setup";
import { liveStats } from "@/server/stats";
import "../app.css";
import "../rig.css";

export const metadata: Metadata = { title: "Get started · Sandchest" };

/**
 * Where "Get started" leads: the first step of recruiting, before there is
 * anyone to recruit for. Its way forward is signing in with GitHub, which
 * comes back to the same step to connect an account; nothing past it opens
 * until one is connected. Signed in already, it is that step itself.
 */
export default async function GetStartedPage() {
  // Rendered per request, never at build: it reads the server's settings and the visitor's session, and a
  // build has neither.
  await connection();
  // A server without a GitHub App or sign-in yet: the sign-in page explains what's missing.
  // Recruiting starts with GitHub sign-in; a Forgejo-only deployment signs in on its own page.
  if (setupNeeded() || !signInProviders().includes("github")) redirect("/sign-in");
  if (await currentUser()) redirect("/dashboard/recruit");
  const [stats, claim] = await Promise.all([liveStats().catch(() => null), claimIntent(null)]);
  return (
    <Recruit
      accounts={[]}
      initial={null}
      startAt="connect"
      viewer="you"
      installUrl={null}
      billing={billingEnabled()}
      publishableKey={null}
      stats={stats}
      claim={claim}
      signIn={signIn.bind(null, "/dashboard/recruit")}
    />
  );
}
