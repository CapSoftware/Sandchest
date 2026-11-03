import { PageSkeleton } from "@/components/app/skeleton";

const SAMPLE = ["api", "web", "worker", "billing", "docs", "mobile"];

/** Shown the instant a link is followed, until the repos arrive. */
export default function Loading() {
  return (
    <PageSkeleton id="repos" label="Loading repos">
      <div className="page-head">
        <div>
          <h1 className="page-title">Repos</h1>
          <p className="page-sub">6 repositories, 3 open findings. Most exposed first.</p>
        </div>
        <span className="key key-secondary">
          <span className="key-face">Add repositories</span>
        </span>
      </div>
      <div className="repo-table">
        <div className="repo-table-head">
          <span>Repository</span>
          <span>Open findings</span>
          <span className="repo-table-num">Reviews, 30 days</span>
          <span>Last scan</span>
        </div>
        {SAMPLE.map((name) => (
          <a key={name} className="repo-line">
            <span className="repo-line-name">
              <span className="repo-line-repo">{name}</span>
            </span>
            <span className="tally tally-clear">Nothing open</span>
            <span className="repo-table-num repo-line-dim">4</span>
            <span className="repo-line-dim">PR review 2 hr. ago</span>
          </a>
        ))}
      </div>
    </PageSkeleton>
  );
}
