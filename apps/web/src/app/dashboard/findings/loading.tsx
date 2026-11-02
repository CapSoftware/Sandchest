import { Heat } from "@/components/app/heat";
import { PageSkeleton } from "@/components/app/skeleton";
import { SEVERITY_LABEL, type Severity } from "@/lib/format";

/** Findings to measure the first skeleton from, before the page has been seen on this browser. */
const SAMPLE: Array<{ severity: Severity; title: string; where: string }> = [
  { severity: "critical", title: "Any signed-in user can read another account's invoices", where: "acme/api src/routes/invoices.ts:42" },
  { severity: "high", title: "Webhook signature is checked after the payload is parsed", where: "acme/api src/webhooks/handler.ts:118" },
  { severity: "medium", title: "Redirect target is taken from the query string", where: "acme/web app/sign-in/page.tsx:27" },
];

/** Shown the instant a link is followed, until the findings arrive. */
export default function Loading() {
  return (
    <PageSkeleton id="findings" label="Loading findings">
      <div className="page-head">
        <h1 className="page-title">Findings</h1>
      </div>
      <div className="filters">
        <nav className="tabs">
          {["Open", "Fixed", "Dismissed"].map((label) => (
            <span key={label} className="tab">
              {label}
              <span className="tab-count">3</span>
            </span>
          ))}
        </nav>
        <div className="filter-set">
          <div className="chips">
            {(Object.keys(SEVERITY_LABEL) as Severity[]).map((severity) => (
              <span key={severity} className="chip">
                {SEVERITY_LABEL[severity]}
              </span>
            ))}
          </div>
          <span className="chip">Low confidence</span>
        </div>
      </div>
      <ul className="rows">
        {SAMPLE.map((finding) => (
          <li key={finding.title} className="row finding-row">
            <a>
              <Heat severity={finding.severity} label />
              <span className="finding-row-title">{finding.title}</span>
              <span className="finding-row-when">2 hr. ago</span>
              <span className="finding-row-where">{finding.where}</span>
            </a>
          </li>
        ))}
      </ul>
    </PageSkeleton>
  );
}
