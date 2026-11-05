import type { Metadata } from "next";
import { PageShape } from "@/components/app/skeleton";
import { viewer } from "@/server/access";
import { AccountView } from "../settings-view";

export const metadata: Metadata = { title: "Account · Settings · Sandchest" };

export default async function AccountSettingsPage() {
  const user = await viewer();
  return (
    <PageShape id="settings-account">
      <AccountView user={user} />
    </PageShape>
  );
}
