import type { ScanListItem } from "@sandchest/db";
import { creditsText, duration, plural, SCAN_KIND_LABEL, SCAN_STATUS_LABEL, SEVERITIES } from "@/lib/format";
import { Heat } from "./heat";
import { HoverLink } from "./hover-link";
import { When } from "./when";

const ACTIVE = new Set(["queued", "running", "publishing"]);

/** What a run was: "PR #212" for a review, otherwise its kind. */
export function scanName(scan: { kind: string; prNumber: number | null }): string {
  return scan.kind === "pr_review" && scan.prNumber !== null ? `PR #${scan.prNumber}` : (SCAN_KIND_LABEL[scan.kind] ?? "Scan");
}

/**
 * Runs as rows: what ran, where, what it found, what it cost and when. Each
 * opens the run. `compact` stacks the repo under the name and drops the cost,
 * for narrow columns.
 */
export function ScanRows({ scans, repo = true, compact = false }: { scans: ScanListItem[]; repo?: boolean; compact?: boolean }) {
  return (
    <ul className="rows scan-rows" data-repo={repo || undefined} data-compact={compact || undefined}>
      {scans.map((scan) => (
        <li key={scan.id} className="row">
          <HoverLink href={`/dashboard/scans/${scan.id}`} className="scan-row">
            <span className="scan-dot" data-status={scan.status} aria-hidden="true" />
            <span className="scan-row-what">
              {scanName(scan)}
              {scan.kind === "pr_review" && <span className="scan-row-kind"> review</span>}
            </span>
            {repo && <span className="scan-row-repo">{scan.repoFullName}</span>}
            <span className="scan-row-result">
              <Result scan={scan} />
            </span>
            <span className="scan-row-cost">{cost(scan)}</span>
            <span className="scan-row-took">{scan.durationMs !== null && !ACTIVE.has(scan.status) ? duration(scan.durationMs) : ""}</span>
            <span className="scan-row-when">
              <When date={scan.createdAt} />
            </span>
          </HoverLink>
        </li>
      ))}
    </ul>
  );
}

function Result({ scan }: { scan: ScanListItem }) {
  if (ACTIVE.has(scan.status))
    return (
      <span className="scan-result-live">
        <span className="blink" aria-hidden="true" />
        {/* Recon is the map every other scan of the repo starts from, not a scan for findings. */}
        {scan.kind === "recon" && scan.status !== "publishing" ? "Mapping the code" : SCAN_STATUS_LABEL[scan.status]}
      </span>
    );
  if (scan.status !== "completed") return <span className="scan-result-off" data-status={scan.status}>{SCAN_STATUS_LABEL[scan.status] ?? scan.status}</span>;
  if (scan.kind === "recon") return <span className="scan-result-quiet">Mapped</span>;
  const total = SEVERITIES.reduce((sum, severity) => sum + scan.found[severity], 0);
  const top = SEVERITIES.find((severity) => scan.found[severity] > 0);
  if (!top) return <span className="scan-result-quiet">{scan.kind === "fix_check" ? "Checked" : "Nothing found"}</span>;
  return (
    <span className="scan-result-found">
      <Heat severity={top} />
      {plural(total, "finding")}
    </span>
  );
}

function cost(scan: ScanListItem): string {
  if (scan.credits > 0) return creditsText(scan.credits);
  return scan.status === "completed" ? "Free" : "–";
}
