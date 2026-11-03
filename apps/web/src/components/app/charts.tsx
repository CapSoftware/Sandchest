import type { CSSProperties } from "react";
import { dayMonth, plural, SEVERITIES, SEVERITY_LABEL, type Severity } from "@/lib/format";

/**
 * Charts in the house style: square pixel columns on the dark ground, drawn
 * with plain elements on the server. Heights snap to whole pixel rows, so a
 * bar is always a stack of whole blocks, like the heat meter. In a loading
 * state each plot is drawn as one block (`skullet-block`), not as columns of
 * sample data that would jump when the real numbers arrive.
 */

/** How many rows of `rows` a value fills: at least one when it is above zero. */
function fill(value: number, max: number, rows: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(1, Math.round((value / max) * rows));
}

/** A small run of daily columns under a number. */
export function Spark({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(...values, 1);
  return (
    <span className="spark" role="img" aria-label={label} skullet-block="">
      {values.map((value, i) => (
        <i key={i} style={{ "--h": fill(value, max, 7) } as CSSProperties} data-zero={value === 0 || undefined} />
      ))}
    </span>
  );
}

export interface ActivityDay {
  day: string;
  reviews: number;
  deep: number;
}

/** Pull request reviews and deep scans per day, stacked. */
export function ActivityChart({ days }: { days: ActivityDay[] }) {
  const max = Math.max(...days.map((d) => d.reviews + d.deep), 1);
  const reviews = days.reduce((sum, d) => sum + d.reviews, 0);
  const deep = days.reduce((sum, d) => sum + d.deep, 0);
  const middle = Math.floor((days.length - 1) / 2);
  return (
    <figure className="activity">
      <div className="activity-plot" skullet-block="" role="img" aria-label={`${plural(reviews, "pull request review")} and ${plural(deep, "deep scan")} over ${days.length} days, at most ${max} in a day.`}>
        <span className="activity-max" aria-hidden="true">
          {max}
        </span>
        <div className="activity-cols">
          {days.map((d) => {
            const total = fill(d.reviews + d.deep, max, 16);
            const deepRows = d.deep > 0 ? Math.max(1, Math.round((d.deep / (d.reviews + d.deep)) * total)) : 0;
            return (
              <span key={d.day} className="activity-col" title={`${dayMonth(d.day)}: ${plural(d.reviews, "review")}${d.deep ? `, ${plural(d.deep, "deep scan")}` : ""}`}>
                <i className="activity-deep" style={{ "--h": deepRows } as CSSProperties} />
                <i className="activity-reviews" style={{ "--h": total - deepRows } as CSSProperties} />
              </span>
            );
          })}
        </div>
      </div>
      <div className="activity-axis" aria-hidden="true">
        <span>{dayMonth(days[0]!.day)}</span>
        <span>{dayMonth(days[middle]!.day)}</span>
        <span>Today</span>
      </div>
      <figcaption className="legend">
        <span className="legend-key" data-series="reviews">
          Pull request reviews
        </span>
        <span className="legend-key" data-series="deep">
          Deep scans
        </span>
      </figcaption>
    </figure>
  );
}

/** Open findings as one row of pixel cells, coloured by severity. */
export function SeverityStrip({ open, cells = 48 }: { open: Record<Severity, number>; cells?: number }) {
  const total = SEVERITIES.reduce((sum, s) => sum + open[s], 0);
  const counts = SEVERITIES.map((severity) => ({ severity, n: fill(open[severity], total, cells) }));
  // Rounding can overshoot by a cell or two: take them from the largest.
  let over = counts.reduce((sum, c) => sum + c.n, 0) - cells;
  while (over > 0) {
    const largest = counts.reduce((a, b) => (b.n > a.n ? b : a));
    largest.n--;
    over--;
  }
  const used = counts.reduce((sum, c) => sum + c.n, 0);
  return (
    <span className="strip" skullet-block="" role="img" aria-label={SEVERITIES.filter((s) => open[s] > 0).map((s) => `${open[s]} ${SEVERITY_LABEL[s].toLowerCase()}`).join(", ") || "Nothing open"}>
      {counts.flatMap(({ severity, n }) => Array.from({ length: n }, (_, i) => <i key={`${severity}-${i}`} data-severity={severity} />))}
      {Array.from({ length: cells - used }, (_, i) => (
        <i key={`empty-${i}`} />
      ))}
    </span>
  );
}
