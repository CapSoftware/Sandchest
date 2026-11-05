import type { Metadata } from "next";
import { demoSettings } from "@/lib/demo";
import { GeneralView } from "../../dashboard/settings/settings-view";

export const metadata: Metadata = { title: "Settings · Sandchest demo" };

/** The made-up account's settings. Every form stops at a note that this is a demo. */
export default function DemoSettingsPage() {
  return <GeneralView orgs={demoSettings().orgs} />;
}
