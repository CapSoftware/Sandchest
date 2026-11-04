import type { Metadata } from "next";
import { HackerStage } from "@/components/hacker/hacker-stage";
import { DEMO_HACKER, DEMO_LIVE_SCAN_ID, DEMO_LOGIN, DEMO_ORG_ID, demoRecord, demoScans } from "@/lib/demo";
import { HackerRecordView } from "../../dashboard/hacker/hacker-view";
import "../../rig.css";
import "../../hacker.css";

export const metadata: Metadata = { title: `${DEMO_HACKER.handle} · Sandchest demo` };

/** The demo's hacker, at their desk, on the looping deep scan. Customizing works, for this visit only. */
export default function DemoHackerPage() {
  return (
    <>
      <HackerStage orgId={DEMO_ORG_ID} login={DEMO_LOGIN} profile={DEMO_HACKER} admin job={{ href: `/dashboard/scans/${DEMO_LIVE_SCAN_ID}`, label: `deep scan of ${DEMO_LOGIN}/api`, queued: false }} />
      <HackerRecordView login={DEMO_LOGIN} record={demoRecord()} recent={demoScans({}, 6)} others={[]} />
    </>
  );
}
