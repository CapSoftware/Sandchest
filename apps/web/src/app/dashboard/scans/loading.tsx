import { PageSkeleton } from "@/components/app/skeleton";

const SAMPLE = ["PR #212", "Deep scan", "PR #211", "PR #87", "Fix check", "PR #210"];

/** Shown the instant a link is followed, until the scans arrive. */
export default function Loading() {
  return (
    <PageSkeleton id="scans" label="Loading scans">
      <div className="page-head">
        <div>
          <h1 className="page-title">Scans</h1>
          <p className="page-sub">Every review, deep scan, fix check and recon, newest first. Open one to see what it read and found.</p>
        </div>
      </div>
      <ul className="rows scan-rows" data-repo>
        {SAMPLE.map((name, i) => (
          <li key={i} className="row">
            <a className="scan-row">
              <span className="scan-dot" />
              <span className="scan-row-what">{name}</span>
              <span className="scan-row-repo">acme/web</span>
              <span className="scan-row-result">Nothing found</span>
              <span className="scan-row-cost">1 credit</span>
              <span className="scan-row-when">2 hr. ago</span>
            </a>
          </li>
        ))}
      </ul>
    </PageSkeleton>
  );
}
