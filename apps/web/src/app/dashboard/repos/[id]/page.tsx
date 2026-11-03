import { dashboardFindings, dashboardRepos, dashboardScans } from "@sandchest/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PageShape } from "@/components/app/skeleton";
import { isUuid } from "@/lib/uuid";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { orgPlans } from "@/server/org-plans";
import { HISTORY, RepoView } from "./repo-view";

type Params = { params: Promise<{ id: string }> };

const load = cache(async (id: string) => {
  if (!isUuid(id)) return undefined;
  const user = await viewer();
  const [repo] = await dashboardRepos(db(), user.id, { repoId: id });
  return repo ? { user, repo } : undefined;
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const row = await load((await params).id);
  return { title: row ? `${row.repo.fullName} · Sandchest` : "Repository · Sandchest" };
}

export default async function RepoPage({ params }: Params) {
  const row = await load((await params).id);
  if (!row) notFound();
  const { user, repo } = row;
  const [plans, findings, history] = await Promise.all([orgPlans([repo]), dashboardFindings(db(), user.id, { repoId: repo.id }, 8), dashboardScans(db(), user.id, { repoId: repo.id }, HISTORY)]);
  return (
    <PageShape id="repo">
      <RepoView repo={repo} plan={plans.get(repo.orgId)} findings={findings} history={history} />
    </PageShape>
  );
}
