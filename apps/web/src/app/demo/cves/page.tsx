import type { Metadata } from "next";
import { cveDirectory } from "@/lib/cve-samples";
import { demoRepoId, demoRepos } from "@/lib/demo";
import { CvesView, parse, type Query } from "../../dashboard/cves/cves-view";

export const metadata: Metadata = { title: "CVEs · Sandchest demo" };

export default async function DemoCvesPage({ searchParams }: { searchParams: Promise<Query> }) {
  const current = parse(await searchParams);
  const { list, counts } = cveDirectory(demoRepoId, { state: current.state, severities: current.severities, repoId: current.repo, query: current.q });
  const repos = demoRepos().map(({ id, fullName }) => ({ id, fullName }));
  return <CvesView current={current} list={list} counts={counts} repos={repos} coverage={{ repos: repos.length, inventoried: repos.length, queued: 0, checkedAt: new Date(Date.now() - 2 * 3_600_000) }} unchecked={[]} />;
}
