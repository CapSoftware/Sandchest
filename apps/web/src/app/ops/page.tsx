import { adminFindingActivity, adminFindingTallies, adminScanTallies } from "@sandchest/db";
import type { Metadata } from "next";
import { AdminHead } from "@/components/admin/admin-head";
import { Meter } from "@/components/admin/charts";
import { Heat } from "@/components/app/heat";
import { count, percent } from "@/lib/admin-format";
import { outcomes, parseRange, ratio, survival } from "@/lib/admin-metrics";
import { SCAN_KIND_LABEL, SEVERITIES } from "@/lib/format";
import { requireAdmin } from "@/server/admin";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Quality · Admin · Sandchest" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const KINDS = ["pr_review", "deep", "fix_check", "recon"] as const;
const CONFIDENCES = ["high", "medium", "low"] as const;
/** Scan statuses, as columns: anything still going counts as running. */
const STATUS_COLUMNS = [
  { label: "Done", statuses: ["completed"] },
  { label: "Failed", statuses: ["failed"] },
  { label: "Refused", statuses: ["refused"] },
  { label: "Cancelled", statuses: ["cancelled"] },
  { label: "Running", statuses: ["queued", "running", "publishing"] },
] as const;

export default async function QualityPage({ searchParams }: Props) {
  await requireAdmin();
  const range = parseRange((await searchParams).range);
  const [scans, findings, activity] = await Promise.all([adminScanTallies(db(), range), adminFindingTallies(db(), range), adminFindingActivity(db(), range)]);

  const kept = survival(scans);
  const result = outcomes(findings);
  const totalScans = scans.reduce((sum, row) => sum + row.scans, 0);
  const failed = scans.filter((row) => row.status === "failed").reduce((sum, row) => sum + row.scans, 0);
  const acted = (type: string, auto?: boolean) => activity.filter((row) => row.type === type && (auto === undefined || row.auto === auto)).reduce((sum, row) => sum + row.findings, 0);
  const cell = (severity: string, confidence?: string) => findings.filter((row) => row.severity === severity && (!confidence || row.confidence === confidence));

  return (
    <>
      <AdminHead page="/admin" range={range} scope="Scans started and findings first seen" />

      <dl className="stats admin-stats">
        <div className="stat">
          <dt>Kept by the skeptic</dt>
          <dd>{percent(kept.total.rate)}</dd>
          <dd className="stat-note">
            {count(kept.total.survivors)} of {count(kept.total.candidates)} candidates
          </dd>
        </div>
        <div className="stat">
          <dt>Production precision</dt>
          <dd>{percent(result.precision)}</dd>
          <dd className="stat-note">
            {count(result.falsePositive)} false positives in {count(result.reviewed)} reviewed
          </dd>
        </div>
        <div className="stat">
          <dt>Fixed</dt>
          <dd>{percent(result.fixRate)}</dd>
          <dd className="stat-note">{percent(result.autoFixShare)} caught by fix checks</dd>
        </div>
        <div className="stat">
          <dt>Fix prompt taken</dt>
          <dd>{percent(result.promptCopyRate)}</dd>
          <dd className="stat-note">of {count(result.shown)} findings shown</dd>
        </div>
        <div className="stat">
          <dt>Scans failed</dt>
          <dd>{percent(ratio(failed, totalScans))}</dd>
          <dd className="stat-note">
            {count(failed)} of {count(totalScans)} scans
          </dd>
        </div>
      </dl>

      <section className="block admin-block" aria-labelledby="survival-title">
        <h2 id="survival-title" className="block-title">
          Candidates and survivors
        </h2>
        <ul className="admin-meters">
          {kept.byKind.map((row) => (
            <li key={row.kind}>
              <span className="admin-meter-label">{SCAN_KIND_LABEL[row.kind]}</span>
              <Meter value={row.survivors} max={row.candidates} label={`${SCAN_KIND_LABEL[row.kind]}: ${row.survivors} of ${row.candidates} candidates kept`} />
              <span className="admin-meter-value">
                {count(row.survivors)} of {count(row.candidates)} kept <span className="admin-dim">({percent(row.rate)})</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="block admin-block" aria-labelledby="findings-title">
        <h2 id="findings-title" className="block-title">
          Findings by severity and confidence
        </h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Severity</th>
                {CONFIDENCES.map((confidence) => (
                  <th key={confidence} scope="col">
                    {confidence[0]!.toUpperCase() + confidence.slice(1)} confidence
                  </th>
                ))}
                <th scope="col">Fixed</th>
                <th scope="col">False positive</th>
                <th scope="col">Prompt taken</th>
              </tr>
            </thead>
            <tbody>
              {SEVERITIES.map((severity) => {
                const rates = outcomes(cell(severity));
                return (
                  <tr key={severity}>
                    <th scope="row">
                      <Heat severity={severity} label />
                    </th>
                    {CONFIDENCES.map((confidence) => (
                      <td key={confidence}>{count(cell(severity, confidence).reduce((sum, row) => sum + row.total, 0))}</td>
                    ))}
                    <td>{percent(rates.fixRate)}</td>
                    <td>{percent(rates.falsePositiveRate)}</td>
                    <td>{percent(rates.promptCopyRate)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="admin-footnote">
          Rates count findings people are shown: high and medium confidence, each where it stands now. False positives are a share of reviewed findings (fixed or dismissed); open ones have not been judged.
        </p>
      </section>

      <section className="block admin-block" aria-labelledby="scans-title">
        <h2 id="scans-title" className="block-title">
          Scans by kind and status
        </h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Kind</th>
                {STATUS_COLUMNS.map((column) => (
                  <th key={column.label} scope="col">
                    {column.label}
                  </th>
                ))}
                <th scope="col">Total</th>
                <th scope="col">Failed</th>
              </tr>
            </thead>
            <tbody>
              {KINDS.map((kind) => {
                const rows = scans.filter((row) => row.kind === kind);
                const total = rows.reduce((sum, row) => sum + row.scans, 0);
                const of = (statuses: readonly string[]) => rows.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row.scans, 0);
                return (
                  <tr key={kind}>
                    <th scope="row">{SCAN_KIND_LABEL[kind]}</th>
                    {STATUS_COLUMNS.map((column) => (
                      <td key={column.label}>{count(of(column.statuses))}</td>
                    ))}
                    <td>{count(total)}</td>
                    <td>{percent(ratio(of(["failed"]), total))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="block admin-block" aria-labelledby="activity-title">
        <h2 id="activity-title" className="block-title">
          What people and fix checks did
        </h2>
        <dl className="stats admin-stats admin-stats-quiet">
          <div className="stat">
            <dt>Fixed by fix checks</dt>
            <dd>{count(acted("fixed", true))}</dd>
          </div>
          <div className="stat">
            <dt>Marked fixed by people</dt>
            <dd>{count(acted("fixed", false))}</dd>
          </div>
          <div className="stat">
            <dt>Dismissed</dt>
            <dd>{count(acted("dismissed"))}</dd>
          </div>
          <div className="stat">
            <dt>Reopened</dt>
            <dd>{count(acted("reopened"))}</dd>
          </div>
          <div className="stat">
            <dt>Prompts taken</dt>
            <dd>{count(acted("prompt_copied"))}</dd>
          </div>
        </dl>
        <p className="admin-footnote">Findings acted on in this range, whenever they were found.</p>
      </section>
    </>
  );
}
