import { cveCoverage, cveUnchecked, dashboardCves, visibleRepos } from "@sandchest/db";
import type { Metadata } from "next";
import { after } from "next/server";
import { PageShape } from "@/components/app/skeleton";
import { viewer } from "@/server/access";
import { readUnreadFirst } from "@/server/cves";
import { db } from "@/server/db";
import { startInventory } from "@/server/start";
import { CvesView, parse, type Query } from "./cves-view";

export const metadata: Metadata = { title: "CVEs · Sandchest" };

export default async function CvesPage({ searchParams }: { searchParams: Promise<Query> }) {
  const [user, query] = await Promise.all([viewer(), searchParams]);
  const current = parse(query);
  const [{ list, counts }, repos, coverage, unchecked] = await Promise.all([
    dashboardCves(db(), user.id, { state: current.state, severities: current.severities, repoId: current.repo, query: current.q }),
    visibleRepos(db(), user.id),
    cveCoverage(db(), user.id),
    cveUnchecked(db(), user.id),
  ]);
  // Repositories in use and not read yet go first, once the page is on its way.
  if (coverage.queued > 0) after(() => readUnreadFirst(user.id, startInventory));
  return (
    <PageShape id="cves">
      <CvesView current={current} list={list} counts={counts} repos={repos} coverage={coverage} unchecked={unchecked} />
    </PageShape>
  );
}
