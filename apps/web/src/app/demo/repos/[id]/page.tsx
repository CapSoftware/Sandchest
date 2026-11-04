import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PullRows } from "@/components/app/pull-rows";
import { demoFindings, demoPulls, demoRepo, demoScans } from "@/lib/demo";
import { HISTORY, RepoView } from "../../../dashboard/repos/[id]/repo-view";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const repo = demoRepo((await params).id);
  return { title: repo ? `${repo.fullName} · Sandchest demo` : "Repository · Sandchest demo" };
}

export default async function DemoRepoPage({ params }: Params) {
  const repo = demoRepo((await params).id);
  if (!repo) notFound();
  return (
    <RepoView
      repo={repo}
      plan={{ planId: "standard", credits: 120 }}
      findings={demoFindings({ repoId: repo.id }, 8)}
      history={demoScans({ repoId: repo.id }, HISTORY)}
      pulls={<PullRows repoId={repo.id} pulls={demoPulls(repo.id)} mode={repo.prReviews} priced />}
    />
  );
}
