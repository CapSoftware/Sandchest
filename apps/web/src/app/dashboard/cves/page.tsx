import { cveCoverage, dashboardCves, visibleRepos } from "@sandchest/db";
import type { Metadata } from "next";
import { PageShape } from "@/components/app/skeleton";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { CvesView, parse, type Query } from "./cves-view";

export const metadata: Metadata = { title: "CVEs · Sandchest" };

export default async function CvesPage({ searchParams }: { searchParams: Promise<Query> }) {
  const [user, query] = await Promise.all([viewer(), searchParams]);
  const current = parse(query);
  const [{ list, counts }, repos, coverage] = await Promise.all([
    dashboardCves(db(), user.id, { state: current.state, severities: current.severities, repoId: current.repo, query: current.q }),
    visibleRepos(db(), user.id),
    cveCoverage(db(), user.id),
  ]);
  return (
    <PageShape id="cves">
      <CvesView current={current} list={list} counts={counts} repos={repos} coverage={coverage} />
    </PageShape>
  );
}
