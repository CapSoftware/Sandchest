import { dashboardRepos } from "@sandchest/db";
import type { Metadata } from "next";
import { PageShape } from "@/components/app/skeleton";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { ReposView } from "./repos-view";

export const metadata: Metadata = { title: "Repos · Sandchest" };

export default async function ReposPage() {
  const user = await viewer();
  const repos = await dashboardRepos(db(), user.id);
  return (
    <PageShape id="repos">
      <ReposView repos={repos} />
    </PageShape>
  );
}
