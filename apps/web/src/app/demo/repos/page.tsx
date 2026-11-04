import type { Metadata } from "next";
import { demoRepos } from "@/lib/demo";
import { ReposView } from "../../dashboard/repos/repos-view";

export const metadata: Metadata = { title: "Repos · Sandchest demo" };

export default function DemoReposPage() {
  return <ReposView repos={demoRepos()} />;
}
