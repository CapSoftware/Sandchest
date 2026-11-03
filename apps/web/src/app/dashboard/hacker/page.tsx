import { dashboardScans, hackerRecord } from "@sandchest/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { HoverLink } from "@/components/app/hover-link";
import { ScanRows, scanName } from "@/components/app/scan-rows";
import { PageShape } from "@/components/app/skeleton";
import { HackerMark } from "@/components/hacker/hacker-mark";
import { HackerStage } from "@/components/hacker/hacker-stage";
import { compactNumber } from "@/lib/format";
import { readHacker } from "@/lib/hacker";
import { viewer } from "@/server/access";
import { db } from "@/server/db";
import { myHackers } from "@/server/hackers";
import "../../rig.css";
import "../../hacker.css";

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

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
  const jobs = record.jobs.deep + record.jobs.reviews + record.jobs.other;
  const others = crew.filter((c) => c.orgId !== member.orgId);

  return (
    <>
      <HackerStage orgId={member.orgId} login={member.login} profile={profile} admin={member.admin} job={job} />
      <PageShape id="hacker-record">

      <section className="hq-record" aria-label="Service record">
        <dl className="hq-stats">
          <Stat label="Jobs done" value={compactNumber(jobs)} foot={`${compactNumber(record.jobs.reviews)} reviews, ${compactNumber(record.jobs.deep)} deep scans`} />
          <Stat label="Lines read" value={compactNumber(record.lines)} foot="Across every finished scan" />
          <Stat label="Found" value={compactNumber(record.found)} foot={`${compactNumber(record.open)} still open`} />
          <Stat label="Fixed" value={compactNumber(record.fixed)} foot={record.found ? `${Math.round((record.fixed / record.found) * 100)}% of what they found` : "Nothing to fix yet"} />
        </dl>
        <p className="hq-since">{record.since ? `Working for ${member.login} since ${MONTH.format(record.since)}.` : `Hasn’t started on ${member.login} yet.`}</p>
      </section>

      <div className={others.length > 0 ? "hq-grid" : undefined}>
        <section className="panel" aria-labelledby="hq-jobs">
          <div className="panel-head">
            <h2 id="hq-jobs" className="block-title">
              Latest jobs
            </h2>
            <HoverLink href="/dashboard/scans" className="panel-link">
              All scans
            </HoverLink>
          </div>
          {recent.length === 0 ? <p className="panel-empty">No jobs yet. The next pull request is theirs.</p> : <ScanRows scans={recent} compact />}
        </section>

        {others.length > 0 && (
          <section className="panel" aria-labelledby="hq-crew">
            <div className="panel-head">
              <h2 id="hq-crew" className="block-title">
                The rest of your crew
              </h2>
            </div>
            <ul className="rows">
              {others.map((other) => {
                const look = readHacker(other.hacker);
                return (
                  <li key={other.orgId} className="row">
                    <HoverLink href={`/dashboard/hacker?org=${other.orgId}`} className="hq-crew-row">
                      <HackerMark profile={look} size={32} />
                      <span className="hq-crew-name">{look.handle}</span>
                      <span className="hq-crew-org">{other.login}</span>
                      {other.working && <span className="blink" aria-label="On a job" />}
                    </HoverLink>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
      </PageShape>
    </>
  );
}

function Stat({ label, value, foot }: { label: string; value: string; foot: string }) {
  return (
    <div className="hq-stat">
      <dt>{label}</dt>
      <dd className="hq-stat-value">{value}</dd>
      <dd className="hq-stat-foot">{foot}</dd>
    </div>
  );
}
