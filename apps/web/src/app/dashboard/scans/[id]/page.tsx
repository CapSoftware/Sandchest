import { dashboardRepos, pendingRecon, scanForUser } from "@sandchest/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PageShape } from "@/components/app/skeleton";
import { isUuid } from "@/lib/uuid";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { orgPlans } from "@/server/org-plans";
import { ACTIVE, ScanView, title } from "./scan-view";

type Params = { params: Promise<{ id: string }> };

const load = cache(async (id: string) => {
  const user = await viewer();
  return isUuid(id) ? scanForUser(db(), user.id, id, { events: 1_000 }) : undefined;
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const row = await load((await params).id);
  return { title: row ? `${title(row.scan.kind, row.scan.prNumber)} · Sandchest` : "Scan · Sandchest" };
}

export default async function ScanPage({ params }: Params) {
  const { id } = await params;
  const row = await load(id);
  if (!row) notFound();
  const user = await viewer();
  // A finished deep scan can be run again from here: the repo's Dig key, priced for its org.
  const again =
    row.scan.kind === "deep" && !ACTIVE.has(row.scan.status)
      ? await dashboardRepos(db(), user.id, { repoId: row.repo.id }).then(async ([repo]) => (repo ? { repo, plan: (await orgPlans([repo])).get(repo.orgId) } : undefined))
      : undefined;
  // A recon that a deep scan is waiting for points on to it: that's the scan they're here for.
  const next =
    row.scan.kind === "recon" && ACTIVE.has(row.scan.status)
      ? await dashboardRepos(db(), user.id, { repoId: row.repo.id }).then(([repo]) => (repo?.activeDeepScanWaitsForRecon ? (repo.activeDeepScanId ?? undefined) : undefined))
      : undefined;
  // A deep scan queued behind its repo's recon points back to it: that's what it's waiting on.
  const waitingOn = row.scan.kind === "deep" && row.scan.status === "queued" ? await pendingRecon(db(), row.repo.id) : undefined;
  return (
    <PageShape id="scan">
      <ScanView row={row} again={again} next={next} waitingOn={waitingOn} />
    </PageShape>
  );
}
