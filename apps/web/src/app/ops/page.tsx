import { adminFindingActivity, adminFindingTallies, adminScanTallies } from "@sandchest/db";
import type { Metadata } from "next";
import { PageShape } from "@/components/app/skeleton";
import { parseRange } from "@/lib/admin-metrics";
import { requireAdmin } from "@/server/admin";
import { replicaDb } from "@/server/db";
import { QualityView } from "./quality-view";

export const metadata: Metadata = { title: "Quality · Admin · Sandchest" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function QualityPage({ searchParams }: Props) {
  await requireAdmin();
  const range = parseRange((await searchParams).range);
  const [scans, findings, activity] = await Promise.all([adminScanTallies(replicaDb(), range), adminFindingTallies(replicaDb(), range), adminFindingActivity(replicaDb(), range)]);
  return (
    <PageShape id="ops-quality">
      <QualityView range={range} scans={scans} findings={findings} activity={activity} />
    </PageShape>
  );
}
