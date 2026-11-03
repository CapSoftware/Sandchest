import { adminActivity, adminDailySignups, adminFunnel } from "@sandchest/db";
import type { Metadata } from "next";
import { PageShape } from "@/components/app/skeleton";
import { parseRange } from "@/lib/admin-metrics";
import { requireAdmin } from "@/server/admin";
import { config } from "@/server/config";
import { replicaDb } from "@/server/db";
import { FunnelView } from "./funnel-view";

export const metadata: Metadata = { title: "Funnel · Admin · Sandchest" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function FunnelPage({ searchParams }: Props) {
  await requireAdmin();
  const range = parseRange((await searchParams).range);
  // Billing is on when Autumn is configured (as `billingEnabled` decides), without loading the billing client.
  const billing = Boolean(config().AUTUMN_SECRET_KEY);
  const [funnel, activity, daily] = await Promise.all([adminFunnel(replicaDb(), range, { billing }), adminActivity(replicaDb()), adminDailySignups(replicaDb(), range)]);
  return (
    <PageShape id="ops-funnel">
      <FunnelView range={range} billing={billing} funnel={funnel} activity={activity} daily={daily} />
    </PageShape>
  );
}
