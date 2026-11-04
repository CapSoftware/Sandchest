import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DEMO_LIVE_SCAN_ID, demoRepo, demoScan, LIVE_ENDS_AT, LIVE_REST, LIVE_SCRIPT } from "@/lib/demo";
import { ScanView, title } from "../../../dashboard/scans/[id]/scan-view";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const row = demoScan((await params).id);
  return { title: row ? `${title(row.scan.kind, row.scan.prNumber)} · Sandchest demo` : "Scan · Sandchest demo" };
}

/** A made-up scan. The running deep scan plays its script on a loop; every other one is finished, with its log. */
export default async function DemoScanPage({ params }: Params) {
  const { id } = await params;
  const row = demoScan(id);
  if (!row) notFound();
  const repo = row.scan.kind === "deep" && id !== DEMO_LIVE_SCAN_ID ? demoRepo(row.repo.id) : undefined;
  return (
    <ScanView
      row={row}
      again={repo && { repo, plan: { planId: "standard", credits: 120 } }}
      loop={id === DEMO_LIVE_SCAN_ID ? { script: LIVE_SCRIPT, endsAt: LIVE_ENDS_AT, rest: LIVE_REST, joinAt: 4 } : undefined}
    />
  );
}
