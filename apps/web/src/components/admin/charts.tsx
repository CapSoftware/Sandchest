/**
 * Charts for the operator dashboards: plain HTML and CSS, drawn on the
 * server, no client JavaScript. Each bar names its value on hover (title)
 * and every chart has its numbers in a table underneath for keyboard and
 * screen-reader use. One hue per chart (gold); kinds are small multiples,
 * not a stack of colours.
 */
import { dayLabel, niceMax } from "@/lib/admin-format";

interface ColumnChartProps {
  title: string;
  /** A summary beside the title, e.g. the total. */
  note?: string;
  days: string[];
  values: number[];
  format: (value: number) => string;
  /** Smaller, for small multiples. */
  compact?: boolean;
}

/** One column per day from a shared baseline, with three gridlines. */
export function ColumnChart({ title, note, days, values, format, compact = false }: ColumnChartProps) {
  const top = niceMax(Math.max(0, ...values));
  const ticks = compact ? [top] : [top / 2, top];
  const label = `${title}${note ? `, ${note}` : ""}. ${days.length} days from ${dayLabel(days[0]!)} to ${dayLabel(days.at(-1)!)}; highest ${format(Math.max(0, ...values))}.`;
  return (
    <figure className="chart" data-compact={compact ? "" : undefined}>
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        {note && <span className="chart-note">{note}</span>}
      </figcaption>
      <div className="chart-plot" role="img" aria-label={label}>
        {ticks.map((tick) => (
          <span key={tick} className="chart-grid" style={{ bottom: `${(tick / top) * 100}%` }}>
            <span className="chart-tick">{format(tick)}</span>
          </span>
        ))}
        <div className="chart-bars" data-dense={values.length > 45 ? "" : undefined}>
          {values.map((value, i) => (
            <span key={days[i]} className="chart-bar" title={`${dayLabel(days[i]!)}: ${format(value)}`}>
              <span style={{ height: `${(value / top) * 100}%` }} data-zero={value === 0 ? "" : undefined} />
            </span>
          ))}
        </div>
      </div>
      <div className="chart-x" aria-hidden="true">
        <span>{dayLabel(days[0]!)}</span>
        <span>{dayLabel(days.at(-1)!)}</span>
      </div>
      <details className="chart-table">
        <summary>Numbers</summary>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">{title}</th>
            </tr>
          </thead>
          <tbody>
            {[...values.keys()].reverse().map((i) => (
              <tr key={days[i]}>
                <th scope="row">{dayLabel(days[i]!)}</th>
                <td>{format(values[i]!)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** A part of a whole as a gold fill on a hairline track, like the credits meter. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const share = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <span className="meter admin-meter" role="img" aria-label={label}>
      <span style={{ width: `${share * 100}%` }} />
    </span>
  );
}

/** Funnel steps as bars sized against the first step. */
export function FunnelBars({ steps, format, rate }: { steps: Array<{ label: string; count: number; fromPrevious: number | null; fromStart: number | null }>; format: (value: number) => string; rate: (value: number | null) => string }) {
  const first = Math.max(1, steps[0]?.count ?? 0);
  return (
    <ol className="funnel">
      {steps.map((step, i) => (
        <li key={step.label} className="funnel-step">
          <span className="funnel-label">{step.label}</span>
          <span className="funnel-track" aria-hidden="true">
            <span style={{ width: `${(step.count / first) * 100}%` }} data-zero={step.count === 0 ? "" : undefined} />
          </span>
          <span className="funnel-count">{format(step.count)}</span>
          <span className="funnel-rate">{i === 0 ? "" : `${rate(step.fromPrevious)} of the step before`}</span>
        </li>
      ))}
    </ol>
  );
}
