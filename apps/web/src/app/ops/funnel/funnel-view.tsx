import type { adminActivity, adminDailySignups, adminFunnel, AdminRange } from "@sandchest/db";
import { AdminHead } from "@/components/admin/admin-head";
import { ColumnChart, FunnelBars } from "@/components/admin/charts";
import { count, percent } from "@/lib/admin-format";
import { funnelSteps, lastDays, perDay, ratio } from "@/lib/admin-metrics";

/** The dashboard, drawn from what the page read; its loading state draws it from sample numbers. */
/** `billing` when Autumn is configured: the plan step and the paying accounts show. */
export function FunnelView({ range, billing, funnel, activity, daily }: { range: AdminRange; billing: boolean; funnel: Awaited<ReturnType<typeof adminFunnel>>; activity: Awaited<ReturnType<typeof adminActivity>>; daily: Awaited<ReturnType<typeof adminDailySignups>> }) {
  const days = lastDays(range);
  const signups = perDay(days, daily, (row) => row.signups);
  const signIns = perDay(days, daily, (row) => row.signIns);

  return (
    <>
      <AdminHead page="/admin/funnel" range={range} scope="People who signed up" />

      <section className="block admin-block" aria-labelledby="funnel-title">
        <h2 id="funnel-title" className="block-title">
          How far new people got
        </h2>
        <FunnelBars steps={funnelSteps(funnel)} format={count} rate={percent} />
        <p className="admin-footnote">
          Each step counts people who reached every step before it on the same account. “Back” means they opened the dashboard on a later day than they signed up.
        </p>
      </section>

      <section className="block admin-block" aria-labelledby="now-title">
        <h2 id="now-title" className="block-title">
          Active now
        </h2>
        <dl className="stats admin-stats">
          <div className="stat">
            <dt>People, last 7 days</dt>
            <dd>{count(activity.people7)}</dd>
            <dd className="stat-note">{percent(ratio(activity.people7, activity.people))} of everyone</dd>
          </div>
          <div className="stat">
            <dt>People, last 30 days</dt>
            <dd>{count(activity.people30)}</dd>
            <dd className="stat-note">of {count(activity.people)} signed up</dd>
          </div>
          <div className="stat">
            <dt>Accounts scanned, 7 days</dt>
            <dd>{count(activity.orgs7)}</dd>
            <dd className="stat-note">{percent(ratio(activity.orgs7, activity.orgs))} of installed</dd>
          </div>
          <div className="stat">
            <dt>Accounts scanned, 30 days</dt>
            <dd>{count(activity.orgs30)}</dd>
            <dd className="stat-note">of {count(activity.orgs)} installed</dd>
          </div>
          {billing && (
            <div className="stat">
              <dt>Accounts with a plan</dt>
              <dd>{count(activity.paying)}</dd>
              <dd className="stat-note">{percent(ratio(activity.paying, activity.orgs))} of installed</dd>
            </div>
          )}
        </dl>
        <p className="admin-footnote">Not affected by the range. People are active when they open the dashboard; accounts when a scan runs.</p>
      </section>

      <section className="block admin-block admin-multiples" aria-label="Sign-ups and sign-ins per day">
        <ColumnChart counts title="Sign-ups per day" note={count(funnel.signedUp)} days={days} values={signups} format={count} />
        <ColumnChart counts title="Sign-ins per day" note={count(signIns.reduce((a, b) => a + b, 0))} days={days} values={signIns} format={count} />
      </section>
    </>
  );
}
