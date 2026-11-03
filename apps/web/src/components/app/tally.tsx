import type { DashboardRepo } from "@sandchest/db";
import { SEVERITIES } from "@/lib/format";
import { Heat } from "./heat";

/** Open findings by severity, as small heat meters with counts. */
export function Tally({ open }: { open: DashboardRepo["open"] }) {
  const counts = SEVERITIES.filter((severity) => open[severity] > 0);
  if (counts.length === 0) return <span className="tally tally-clear">Nothing open</span>;
  return (
    <span className="tally">
      {counts.map((severity) => (
        <span key={severity} className="tally-n">
          <Heat severity={severity} />
          {open[severity]}
        </span>
      ))}
    </span>
  );
}
