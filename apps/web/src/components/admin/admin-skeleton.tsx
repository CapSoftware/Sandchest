import { PageSkeleton } from "@/components/app/skeleton";
import { ADMIN_RANGES } from "@/lib/admin-metrics";

/** An operator dashboard's loading state: its head, a row of numbers and a chart, until it has been seen once on this browser. */
export function AdminSkeleton({ id, title }: { id: string; title: string }) {
  return (
    <PageSkeleton id={id} label={`Loading ${title.toLowerCase()}`}>
      <div className="page-head">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-sub">Scans started and findings first seen since 1 Oct (UTC). Internal: operators only.</p>
        </div>
      </div>
      <div className="filters">
        <nav className="tabs">
          {["Quality", "Cost", "Funnel"].map((label) => (
            <span key={label} className="tab">
              {label}
            </span>
          ))}
        </nav>
        <nav className="chips">
          {ADMIN_RANGES.map((days) => (
            <span key={days} className="chip">
              {days} days
            </span>
          ))}
        </nav>
      </div>
      <dl className="stats admin-stats">
        {[1, 2, 3, 4, 5].map((n) => (
          <div key={n} className="stat">
            <dt>Production precision</dt>
            <dd>92%</dd>
            <dd className="stat-note">3 of 40 reviewed</dd>
          </div>
        ))}
      </dl>
      <section className="block admin-block">
        <figure className="chart">
          <figcaption className="chart-head">
            <span className="chart-title">Per day</span>
            <span className="chart-note">1,204 in total</span>
          </figcaption>
          <div className="chart-plot" />
        </figure>
      </section>
    </PageSkeleton>
  );
}
