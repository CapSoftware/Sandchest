import { dashboardRepos, lastDeepScanCharges } from "@sandchest/db";
import type { Metadata } from "next";
import { PageShape } from "@/components/app/skeleton";
import { scanChoices } from "@/lib/first-scan";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { myHackers } from "@/server/hackers";
import { orgPlans } from "@/server/org-plans";
import { ReposView } from "./repos-view";

export const metadata: Metadata = { title: "Repos · Sandchest" };

export default async function ReposPage() {
  const user = await viewer();
  const repos = await dashboardRepos(db(), user.id);
  // For the Deep scan key: each account's plan and hacker, and what each repository's last deep scan cost.
  const [plans, hackers, charges] = await Promise.all([
    orgPlans(repos),
    myHackers(user.id).catch(() => []),
    lastDeepScanCharges(db(), repos.map((repo) => repo.id)).catch(() => new Map<string, number>()),
  ]);
  return (
    <PageShape id="repos">
      <ReposView repos={repos} launch={scanChoices(repos, plans, hackers, { charges })} />
    </PageShape>
  );
}
