import { PageSkeleton } from "@/components/app/skeleton";

const KPIS = ["Pull requests reviewed", "Findings", "Fixed", "Credits left"];

/** Shown the instant a link is followed, until the overview arrives. */
export default function Loading() {
  return (
    <PageSkeleton id="overview" label="Loading overview">
      <div className="page-head">
        <div>
          <h1 className="page-title">Overview</h1>
          <p className="page-sub">acme · 12 repositories · last 30 days</p>
        </div>
      </div>
      <dl className="kpis">
        {KPIS.map((label) => (
          <div key={label} className="kpi">
            <dt>{label}</dt>
            <dd className="kpi-value">128</dd>
            <dd className="kpi-spark">
              <span className="spark" style={{ width: "10rem" }} />
            </dd>
            <dd className="kpi-foot">96 the 30 days before</dd>
          </div>
        ))}
      </dl>
      <div className="overview-grid">
        <section className="panel">
          <div className="panel-head">
            <h2 className="block-title">Activity</h2>
          </div>
          <div style={{ height: "11rem" }} />
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2 className="block-title">Open findings</h2>
          </div>
          <div style={{ height: "11rem" }} />
        </section>
      </div>
    </PageSkeleton>
  );
}
