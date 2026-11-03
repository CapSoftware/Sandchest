import type { HackerRecord, ScanListItem, userHackers } from "@sandchest/db";
import { HoverLink } from "@/components/app/hover-link";
import { ScanRows } from "@/components/app/scan-rows";
import { HackerMark } from "@/components/hacker/hacker-mark";
import { compactNumber } from "@/lib/format";
import { readHacker } from "@/lib/hacker";
import "../../rig.css";
import "../../hacker.css";

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** One of the hackers a person works with. */
export type CrewMember = Awaited<ReturnType<typeof userHackers>>[number];

/** The hacker's service record and latest jobs, under their stage; its loading state draws it from a sample hacker. */
export function HackerRecordView({ login, record, recent, others }: { login: string; record: HackerRecord; recent: ScanListItem[]; others: CrewMember[] }) {
  const jobs = record.jobs.deep + record.jobs.reviews + record.jobs.other;
  return (
    <>

      <section className="hq-record" aria-label="Service record">
        <dl className="hq-stats">
          <Stat label="Jobs done" value={compactNumber(jobs)} foot={`${compactNumber(record.jobs.reviews)} reviews, ${compactNumber(record.jobs.deep)} deep scans`} />
          <Stat label="Lines read" value={compactNumber(record.lines)} foot="Across every finished scan" />
          <Stat label="Found" value={compactNumber(record.found)} foot={`${compactNumber(record.open)} still open`} />
          <Stat label="Fixed" value={compactNumber(record.fixed)} foot={record.found ? `${Math.round((record.fixed / record.found) * 100)}% of what they found` : "Nothing to fix yet"} />
        </dl>
        <p className="hq-since">{record.since ? `Working for ${login} since ${MONTH.format(record.since)}.` : `Hasn’t started on ${login} yet.`}</p>
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
