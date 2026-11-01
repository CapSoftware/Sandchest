import { adminActivity, adminDailySignups, adminFunnel } from "@sandchest/db";
import type { Metadata } from "next";
import { AdminHead } from "@/components/admin/admin-head";
import { ColumnChart, FunnelBars } from "@/components/admin/charts";
import { count, percent } from "@/lib/admin-format";
import { funnelSteps, lastDays, parseRange, perDay, ratio } from "@/lib/admin-metrics";
import { requireAdmin } from "@/server/admin";
import { config } from "@/server/config";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Funnel · Admin · Sandchest" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function FunnelPage({ searchParams }: Props) {
  await requireAdmin();
  const range = parseRange((await searchParams).range);
  // Billing is on when Autumn is configured (as `billingEnabled` decides), without loading the billing client.
  const billing = Boolean(config().AUTUMN_SECRET_KEY);
  const [funnel, activity, daily] = await Promise.all([adminFunnel(db(), range, { billing }), adminActivity(db()), adminDailySignups(db(), range)]);

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
