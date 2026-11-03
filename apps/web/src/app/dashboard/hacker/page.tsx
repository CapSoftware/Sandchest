import { dashboardScans, hackerRecord } from "@sandchest/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { scanName } from "@/components/app/scan-rows";
import { PageShape } from "@/components/app/skeleton";
import { HackerStage } from "@/components/hacker/hacker-stage";
import { readHacker } from "@/lib/hacker";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { myHackers } from "@/server/hackers";
import { HackerRecordView } from "./hacker-view";
import "../../rig.css";
import "../../hacker.css";

type Props = { searchParams: Promise<{ org?: string }> };

async function chosen(org: string | undefined) {
  const user = await viewer();
  const crew = await myHackers(user.id);
  return { user, crew, member: crew.find((c) => c.orgId === org) ?? crew[0] };
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const { member } = await chosen((await searchParams).org);
  return { title: `${member ? readHacker(member.hacker).handle : "Your hacker"} · Sandchest` };
}

/**
 * The hacker's own page: them at their desk, what they're on, their service
 * record and their latest jobs. Admins customize them here; there is no
 * swapping one hacker for another. `?org=` picks another account's hacker.
 */
export default async function HackerPage({ searchParams }: Props) {
  const { user, crew, member } = await chosen((await searchParams).org);
  if (!member) redirect("/dashboard/recruit");
  const [record, recent] = await Promise.all([hackerRecord(db(), user.id, member.orgId), dashboardScans(db(), user.id, { orgId: member.orgId }, 6)]);
  const profile = readHacker(member.hacker);
  const active = record.active;
  const job = active
    ? { href: `/dashboard/scans/${active.id}`, label: `${scanName({ kind: active.kind, prNumber: null }).toLowerCase()} of ${active.repoFullName}`, queued: active.status === "queued" }
    : null;
  const others = crew.filter((c) => c.orgId !== member.orgId);

  return (
    <>
      <HackerStage orgId={member.orgId} login={member.login} profile={profile} admin={member.admin} job={job} />
      <PageShape id="hacker-record">
        <HackerRecordView login={member.login} record={record} recent={recent} others={others} />
      </PageShape>
    </>
  );
}
