import { userById } from "@sandchest/db";
import type { Metadata } from "next";
import { Recruit } from "@/components/recruit/recruit";
import { viewer } from "@/server/access";
import { billingEnabled, stripePublishableKey } from "@/server/billing";
import { briefing, recruitAccounts } from "@/server/briefing";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { claimIntent } from "@/server/free-credits";
import { liveStats } from "@/server/stats";
import "../../rig.css";

export const metadata: Metadata = { title: "Recruit your hacker · Sandchest" };

/**
 * Setting up Sandchest, from GitHub to joining: connect an account, say
 * who the company is and where to look first, recruit the hacker, then add
 * credits and pay (or, for someone who came to claim them, take free
 * credits). `?org=` opens it on an account already connected.
 */
export default async function RecruitPage({ searchParams }: { searchParams: Promise<{ org?: string }> }) {
  const { org } = await searchParams;
  const user = await viewer();
  const [accounts, row, stats, claim] = await Promise.all([recruitAccounts(user.id), userById(db(), user.id), liveStats().catch(() => null), claimIntent(user)]);
  const asked = org && accounts.some((account) => account.id === org) ? org : null;
  const chosen = asked ?? (accounts.length === 1 ? accounts[0]!.id : null);
  const initial = chosen ? ((await briefing({ id: user.id, email: row?.email ?? null }, chosen)) ?? null) : null;
  const slug = config().GITHUB_APP_SLUG;
  return (
    <Recruit
      accounts={accounts}
      initial={initial}
      startAt={asked ? "company" : "connect"}
      viewer={user.login ?? user.name}
      installUrl={slug ? `https://github.com/apps/${slug}/installations/new?state=recruit` : null}
      billing={billingEnabled()}
      publishableKey={stripePublishableKey()}
      stats={stats}
      claim={claim}
    />
  );
}
