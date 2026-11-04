import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { demoFinding } from "@/lib/demo";
import { FindingView } from "../../../dashboard/findings/[id]/finding-view";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const row = demoFinding((await params).id);
  return { title: row ? `${row.finding.title} · Sandchest demo` : "Finding · Sandchest demo" };
}

export default async function DemoFindingPage({ params }: Params) {
  const row = demoFinding((await params).id);
  if (!row) notFound();
  return <FindingView row={row} />;
}
