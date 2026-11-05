import { userAgentAccess } from "@sandchest/db";
import type { Metadata } from "next";
import { PageShape } from "@/components/app/skeleton";
import { viewer } from "@/server/access";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { AgentsView } from "../settings-view";

export const metadata: Metadata = { title: "Agents · Settings · Sandchest" };

export default async function AgentsSettingsPage() {
  const user = await viewer();
  const access = await userAgentAccess(db(), user.id);
  return (
    <PageShape id="settings-agents">
      <AgentsView access={access} appUrl={config().SANDCHEST_APP_URL.replace(/\/$/, "")} />
    </PageShape>
  );
}
