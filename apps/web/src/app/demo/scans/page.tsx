import type { Metadata } from "next";
import { demoRepos, demoScans } from "@/lib/demo";
import { PAGE, parse, ScansView, type Query } from "../../dashboard/scans/scans-view";

export const metadata: Metadata = { title: "Scans · Sandchest demo" };

export default async function DemoScansPage({ searchParams }: { searchParams: Promise<Query> }) {
  const current = parse(await searchParams);
  // One page of made-up scans holds all of them: no "older" page to go to.
  const list = demoScans({ kind: current.kind, repoId: current.repo }, PAGE).filter((scan) => !current.before || scan.createdAt < current.before);
  return <ScansView current={current} list={list} repos={demoRepos().map(({ id, fullName }) => ({ id, fullName }))} />;
}
