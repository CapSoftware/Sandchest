import { dashboardRepos, scanForUser } from "@sandchest/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PageShape } from "@/components/app/skeleton";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { orgPlans } from "@/server/org-plans";
import { ACTIVE, ScanView, title } from "./scan-view";

type Params = { params: Promise<{ id: string }> };

const load = cache(async (id: string) => {
  const user = await viewer();
  return /^[0-9a-f-]{36}$/.test(id) ? scanForUser(db(), user.id, id, { events: 1_000 }) : undefined;
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
  return (
    <PageShape id="scan">
      <ScanView row={row} again={again} />
    </PageShape>
  );
}
