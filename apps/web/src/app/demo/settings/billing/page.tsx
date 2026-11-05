import type { Metadata } from "next";
import { demoSettings } from "@/lib/demo";
import { BillingView } from "../../../dashboard/settings/settings-view";

export const metadata: Metadata = { title: "Billing · Settings · Sandchest demo" };

export default function DemoBillingPage() {
  const { orgs, billing } = demoSettings();
  return <BillingView orgs={orgs} billing={[billing]} />;
}
