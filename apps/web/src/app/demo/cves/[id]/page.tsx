import type { Metadata } from "next";
import { cveEntry } from "@/lib/cve-samples";
import { demoRepoId } from "@/lib/demo";
import { CveAbsent, CveView } from "../../../dashboard/cves/[id]/cve-view";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return { title: `${decodeURIComponent((await params).id).slice(0, 80)} · Sandchest demo` };
}

export default async function DemoCvePage({ params }: Params) {
  const key = decodeURIComponent((await params).id).slice(0, 80);
  const row = cveEntry(demoRepoId, key);
  return row ? <CveView row={row} /> : <CveAbsent id={key} />;
}
