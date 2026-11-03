import { dashboardFindings, findingStatusCounts, visibleRepos, type FindingFilters } from "@sandchest/db";
import type { Metadata } from "next";
import { PageShape } from "@/components/app/skeleton";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { FindingsView, parse, type Query } from "./findings-view";

export const metadata: Metadata = { title: "Findings · Sandchest" };

export default async function FindingsPage({ searchParams }: { searchParams: Promise<Query> }) {
  const [user, query] = await Promise.all([viewer(), searchParams]);
  const current = parse(query);
  const filters: FindingFilters = { status: current.status, severities: current.severities, repoId: current.repo, includeLowConfidence: current.low };
  const [list, counts, repos] = await Promise.all([dashboardFindings(db(), user.id, filters), findingStatusCounts(db(), user.id, filters), visibleRepos(db(), user.id)]);
  return (
    <PageShape id="findings">
      <FindingsView current={current} list={list} counts={counts} repos={repos} />
    </PageShape>
  );
}
