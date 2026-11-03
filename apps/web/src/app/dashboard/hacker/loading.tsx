import { PageSkeleton } from "@/components/app/skeleton";
import "../../hacker.css";

/** Shown the instant the hacker's link is followed: the dark stage first, then their record's shape. */
export default function Loading() {
  return (
    <>
      <div className="hq-stage" aria-hidden="true" />
      <PageSkeleton id="hacker-record" label="Loading your hacker">
        <section className="hq-record">
          <dl className="hq-stats">
            {["Jobs done", "Lines read", "Found", "Fixed"].map((label) => (
              <div key={label} className="hq-stat">
                <dt>{label}</dt>
                <dd className="hq-stat-value">128</dd>
                <dd className="hq-stat-foot">Across every finished scan</dd>
              </div>
            ))}
          </dl>
        </section>
      </PageSkeleton>
    </>
  );
}
