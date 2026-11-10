import type { UsageHistoryRow } from "@sandchest/db";
import { money, shortDate } from "@/lib/format";
import { HoverLink } from "./hover-link";
import { scanName } from "./scan-rows";

/** An account's recent scans billed from their usage: when, what, where and what each charged. Each opens its scan. */
export function UsageHistory({ rows }: { rows: UsageHistoryRow[] }) {
  return (
    <div>
      <p className="field-legend">Usage</p>
      <p className="field-help">Recent scans billed by what they used.</p>
      <ul className="rows usage-rows">
        {rows.map((row) => (
          <li key={row.scanId} className="row">
            <HoverLink href={`/dashboard/scans/${row.scanId}`} className="usage-row">
              <span className="usage-row-when">{shortDate(row.billedAt)}</span>
              <span className="usage-row-what">
                {scanName(row)}
                {row.kind === "pr_review" && <span className="scan-row-kind"> review</span>}
              </span>
              <span className="usage-row-repo">{row.repoFullName}</span>
              <span className="usage-row-credits">{row.status === "waived" ? "Not charged" : money(row.credits)}</span>
            </HoverLink>
          </li>
        ))}
      </ul>
    </div>
  );
}
