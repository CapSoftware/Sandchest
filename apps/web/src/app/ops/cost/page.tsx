import { adminCostByKind, adminDailyScans, adminPlanCosts } from "@sandchest/db";
import type { Metadata } from "next";
import { PageShape } from "@/components/app/skeleton";
import { parseRange } from "@/lib/admin-metrics";
import { requireAdmin } from "@/server/admin";
import { replicaDb } from "@/server/db";
import { CostView } from "./cost-view";

export const metadata: Metadata = { title: "Cost · Admin · Sandchest" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CostPage({ searchParams }: Props) {
  await requireAdmin();
  const range = parseRange((await searchParams).range);
  const [byKind, daily, plans] = await Promise.all([adminCostByKind(replicaDb(), range), adminDailyScans(replicaDb(), range), adminPlanCosts(replicaDb(), range)]);
  return (
    <PageShape id="ops-cost">
      <CostView range={range} byKind={byKind} daily={daily} plans={plans} />
    </PageShape>
  );
}
