import { findingForUser } from "@sandchest/db";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { PageShape } from "@/components/app/skeleton";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { FindingView } from "./finding-view";

type Params = { params: Promise<{ id: string }> };

const load = cache(async (id: string) => {
  const user = await viewer();
  return /^[0-9a-f-]{36}$/.test(id) ? findingForUser(db(), user.id, id) : undefined;
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const row = await load((await params).id);
  return { title: row ? `${row.finding.title} · Sandchest` : "Finding · Sandchest" };
}

export default async function FindingPage({ params }: Params) {
  const row = await load((await params).id);
  if (!row) notFound();
  return (
    <PageShape id="finding">
      <FindingView row={row} />
    </PageShape>
  );
}
