import { Heat } from "@/components/app/heat";
import { PageSkeleton } from "@/components/app/skeleton";

/** Repos to measure the first skeleton from, before the page has been seen on this browser. */
const SAMPLE = [
  { name: "api", open: 2, scan: "Deep scan 2 hr. ago" },
  { name: "web", open: 0, scan: "PR review 1 day ago" },
  { name: "worker", open: 1, scan: "Recon 3 days ago" },
];

/** Shown the instant a link is followed, until the repos arrive. */
export default function Loading() {
  return (
    <PageSkeleton id="repos" label="Loading repos">
      <div className="page-head">
        <div>
          <h1 className="page-title">Repos</h1>
          <p className="page-sub">3 repositories, 3 open findings.</p>
        </div>
        <span className="key key-secondary">
          <span className="key-face">Add repositories</span>
        </span>
      </div>
      <ul className="rows">
        {SAMPLE.map((repo) => (
          <li key={repo.name} className="row">
            <div className="repo">
              <div className="repo-name">
                <a>
                  <span className="repo-owner">acme/</span>
                  {repo.name}
                </a>
              </div>
              <div className="tally">
                {repo.open === 0 ? (
                  <span className="tally-clear">Nothing open</span>
                ) : (
                  <a>
                    <Heat severity="high" />
                    {repo.open}
                  </a>
                )}
              </div>
              <div className="repo-scan">
                <a>{repo.scan}</a>
              </div>
              <div className="repo-dig">
                <span className="key key-primary">Dig</span>
                <span className="repo-dig-note">Full deep scan</span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </PageSkeleton>
  );
}
