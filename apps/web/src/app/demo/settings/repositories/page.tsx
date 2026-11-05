import type { Metadata } from "next";
import { demoSettings } from "@/lib/demo";
import { RepositoriesView } from "../../../dashboard/settings/settings-view";

export const metadata: Metadata = { title: "Repositories · Settings · Sandchest demo" };

export default function DemoRepositoriesPage() {
  return <RepositoriesView orgs={demoSettings().orgs} memberOf={[]} />;
}
