import { hackerRecord, liveHistory } from "@sandchest/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { HackerStage } from "@/components/hacker/hacker-stage";
import { fromHistory } from "@/lib/account-feed";
import { readHacker } from "@/lib/hacker";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { myHackers } from "@/server/hackers";
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
 * The hacker's own page: them at their desk filling the window, live, with
 * what's going on across the account on their screen and in a drawer at
 * the foot. Admins customize them here; there is no swapping one hacker for
 * another. `?org=` picks another account's hacker.
 */
export default async function HackerPage({ searchParams }: Props) {
  const { user, crew, member } = await chosen((await searchParams).org);
  if (!member) redirect("/dashboard/recruit");
  const [record, history] = await Promise.all([hackerRecord(db(), user.id, member.orgId), liveHistory(db(), user.id, member.orgId)]);
  const feed = fromHistory(history);
  return (
    <HackerStage
      orgId={member.orgId}
      login={member.login}
      profile={readHacker(member.hacker)}
      admin={member.admin}
      // The latest, to keep the page's HTML small; the live feed fills in from there.
      feed={{ items: feed.items.slice(0, 80), jobs: feed.jobs }}
      record={record}
      crew={crew.filter((c) => c.orgId !== member.orgId)}
    />
  );
}
