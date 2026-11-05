import { cveForUser } from "@sandchest/db";
import type { Metadata } from "next";
import { cache } from "react";
import { PageShape } from "@/components/app/skeleton";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { CveAbsent, CveView } from "./cve-view";

type Params = { params: Promise<{ id: string }> };

/** A CVE id, an advisory id (GHSA-…, PYSEC-…, GO-…, MAL-…) or an alias: letters, digits and dashes. */
const KEY = /^[A-Za-z][A-Za-z0-9._-]{2,79}$/;

const load = cache(async (raw: string) => {
  const key = decodeURIComponent(raw).trim();
  if (!KEY.test(key)) return { key: key.slice(0, 80), row: undefined };
  const user = await viewer();
  return { key, row: await cveForUser(db(), user.id, key) };
});

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { key, row } = await load((await params).id);
  return { title: `${row?.item.key ?? key} · Sandchest` };
}

export default async function CvePage({ params }: Params) {
  const { key, row } = await load((await params).id);
  return <PageShape id="cve">{row ? <CveView row={row} /> : <CveAbsent id={key} />}</PageShape>;
}
