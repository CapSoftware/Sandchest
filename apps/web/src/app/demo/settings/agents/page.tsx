import type { Metadata } from "next";
import { site } from "@/lib/site";
import { AgentsView } from "../../../dashboard/settings/settings-view";

export const metadata: Metadata = { title: "Agents · Settings · Sandchest demo" };

export default function DemoAgentsPage() {
  return <AgentsView access={[]} appUrl={site.url.replace(/\/$/, "")} />;
}
