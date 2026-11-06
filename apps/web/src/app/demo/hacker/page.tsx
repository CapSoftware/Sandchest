import type { Metadata } from "next";
import { HackerStage } from "@/components/hacker/hacker-stage";
import { DEMO_HACKER, DEMO_LOGIN, DEMO_ORG_ID, demoRecord } from "@/lib/demo";
import { demoOpening } from "@/lib/demo-feed";
import "../../rig.css";
import "../../hacker.css";

export const metadata: Metadata = { title: `${DEMO_HACKER.handle} · Sandchest demo` };

/** The demo's hacker, at their desk, live on a made-up account. Customizing works, for this visit only. */
export default function DemoHackerPage() {
  return <HackerStage orgId={DEMO_ORG_ID} login={DEMO_LOGIN} profile={DEMO_HACKER} admin feed={demoOpening()} record={demoRecord()} crew={[]} />;
}
