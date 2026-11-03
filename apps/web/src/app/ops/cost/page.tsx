import { adminCostByKind, adminDailyScans, adminPlanCosts } from "@sandchest/db";
import type { Metadata } from "next";
import { AdminHead } from "@/components/admin/admin-head";
import { ColumnChart } from "@/components/admin/charts";
import { PageShape } from "@/components/app/skeleton";
import { count, money, percent } from "@/lib/admin-format";
import { costPerCredit, dailySeries, kindSummary, lastDays, parseRange, planMargins } from "@/lib/admin-metrics";
import { compactNumber, duration, SCAN_KIND_LABEL } from "@/lib/format";
import { requireAdmin } from "@/server/admin";
import { replicaDb } from "@/server/db";

export const metadata: Metadata = { title: "Cost · Admin · Sandchest" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const KINDS = ["pr_review", "deep", "fix_check", "recon"] as const;

const tokens = (value: number | null) => (value === null ? "–" : compactNumber(value));
const seconds = (ms: number | undefined) => (ms === undefined ? "–" : duration(ms));

export default async function CostPage({ searchParams }: Props) {
  await requireAdmin();
  const range = parseRange((await searchParams).range);
  const [byKind, daily, plans] = await Promise.all([adminCostByKind(replicaDb(), range), adminDailyScans(replicaDb(), range), adminPlanCosts(replicaDb(), range)]);

  const total = byKind.find((row) => row.kind === null);
  const summary = total ? kindSummary(total) : undefined;
  const perCredit = costPerCredit(total);
  const days = lastDays(range);
  const series = dailySeries(days, daily);
  const margins = planMargins(plans);
  const rows = [...KINDS.map((kind) => byKind.find((row) => row.kind === kind)).filter((row) => row !== undefined), ...(total ? [total] : [])].map(kindSummary);

  return (
    <PageShape id="ops-cost">
      <AdminHead page="/admin/cost" range={range} scope="Scans started" />

      <dl className="stats admin-stats">
        <div className="stat">
          <dt>Model cost</dt>
          <dd>{money(total?.modelCostUsd ?? 0)}</dd>
          <dd className="stat-note">{count(total?.scans ?? 0)} scans</dd>
        </div>
        <div className="stat">
          <dt>Per scan</dt>
          <dd>{money(summary?.avgCostUsd ?? null)}</dd>
          <dd className="stat-note">{percent(summary?.cachedShare ?? null)} of input cached</dd>
        </div>
        <div className="stat">
          <dt>Model cost per credit</dt>
          <dd>{money(perCredit.paid)}</dd>
          <dd className="stat-note">{count(total?.creditsCharged ?? 0)} credits, paid scans only</dd>
        </div>
        <div className="stat">
          <dt>Model cost per credit, all in</dt>
          <dd>{money(perCredit.allIn)}</dd>
          <dd className="stat-note">free recon and fix checks included</dd>
        </div>
        <div className="stat">
          <dt>Median scan</dt>
          <dd>{seconds(summary?.duration?.p50)}</dd>
          <dd className="stat-note">p90 {seconds(summary?.duration?.p90)}</dd>
        </div>
      </dl>

      <section className="block admin-block" aria-label="Model cost per day">
        <ColumnChart title="Model cost per day" note={`${money(total?.modelCostUsd ?? 0)} in ${range} days`} days={days} values={series.cost} format={money} />
      </section>

      <section className="block admin-block" aria-labelledby="kinds-title">
        <h2 id="kinds-title" className="block-title">
          By kind
        </h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Kind</th>
                <th scope="col">Scans</th>
                <th scope="col">Input per scan</th>
                <th scope="col">Cached</th>
                <th scope="col">Output per scan</th>
                <th scope="col">Cost per scan</th>
                <th scope="col">Cost</th>
                <th scope="col">p50</th>
                <th scope="col">p90</th>
                <th scope="col">p99</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.kind ?? "total"} data-total={row.kind === null ? "" : undefined}>
                  <th scope="row">{row.kind ? SCAN_KIND_LABEL[row.kind] : "All scans"}</th>
                  <td>{count(row.scans)}</td>
                  <td>{tokens(row.avgInputTokens)}</td>
                  <td>{percent(row.cachedShare)}</td>
                  <td>{tokens(row.avgOutputTokens)}</td>
                  <td>{money(row.avgCostUsd)}</td>
                  <td>{money(row.totalCostUsd)}</td>
                  <td>{seconds(row.duration?.p50)}</td>
                  <td>{seconds(row.duration?.p90)}</td>
                  <td>{seconds(row.duration?.p99)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="admin-footnote">Tokens, cost and durations are averaged over scans that reported usage. Durations are the engine’s own run time.</p>
      </section>

      <section className="block admin-block" aria-labelledby="margin-title">
        <h2 id="margin-title" className="block-title">
          Margin per plan
        </h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">Price per credit</th>
                <th scope="col">Accounts</th>
                <th scope="col">Credits charged</th>
                <th scope="col">Cost per credit</th>
                <th scope="col">Margin</th>
              </tr>
            </thead>
            <tbody>
              {margins.map((row) => (
                <tr key={row.plan.id}>
                  <th scope="row">{row.plan.name}</th>
                  <td>{money(row.revenuePerCredit)}</td>
                  <td>{count(row.orgs)}</td>
                  <td>{count(row.creditsCharged)}</td>
                  <td>{money(row.costPerCredit)}</td>
                  <td data-negative={row.margin !== null && row.margin < 0 ? "" : undefined}>{percent(row.margin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="admin-footnote">
          By each account’s plan today. Cost per credit is the model cost of every scan the plan’s accounts ran, free ones included, over the credits they were charged. Compute (sandboxes) is not recorded yet, so it is not in any figure here.
          Price is the plan’s list price per credit; top-ups sell for more.
        </p>
      </section>

      <section className="block admin-block" aria-labelledby="volume-title">
        <h2 id="volume-title" className="block-title">
          Scans per day
        </h2>
        <div className="admin-multiples">
          {KINDS.map((kind) => {
            const values = series.byKind(kind);
            return <ColumnChart key={kind} compact counts title={SCAN_KIND_LABEL[kind]!} note={count(values.reduce((a, b) => a + b, 0))} days={days} values={values} format={count} />;
          })}
          <ColumnChart compact counts title="Failed" note={count(series.failed.reduce((a, b) => a + b, 0))} days={days} values={series.failed} format={count} />
        </div>
        <p className="admin-footnote">Each chart has its own scale.</p>
      </section>
    </PageShape>
  );
}
