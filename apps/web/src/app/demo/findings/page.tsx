import type { Metadata } from "next";
import { demoFindingCounts, demoFindings, demoRepos } from "@/lib/demo";
import { FindingsView, parse, type Query } from "../../dashboard/findings/findings-view";

export const metadata: Metadata = { title: "Findings · Sandchest demo" };

export default async function DemoFindingsPage({ searchParams }: { searchParams: Promise<Query> }) {
  const current = parse(await searchParams);
  // Every made-up finding is high confidence, so the low-confidence filter changes nothing.
  const filters = { severities: current.severities, repoId: current.repo };
  return <FindingsView current={current} list={demoFindings({ ...filters, status: current.status })} counts={demoFindingCounts(filters)} repos={demoRepos().map(({ id, fullName }) => ({ id, fullName }))} />;
}
