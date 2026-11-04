import type { Metadata } from "next";
import { demoSettings } from "@/lib/demo";
import { site } from "@/lib/site";
import { SettingsView } from "../../dashboard/settings/settings-view";

export const metadata: Metadata = { title: "Settings · Sandchest demo" };

/** The made-up account's settings. Every form stops at a note that this is a demo. */
export default function DemoSettingsPage() {
  const { orgs, billing } = demoSettings();
  return <SettingsView user={{ image: null, login: "you", name: "You" }} orgs={orgs} billing={[billing]} access={[]} appUrl={site.url.replace(/\/$/, "")} />;
}
