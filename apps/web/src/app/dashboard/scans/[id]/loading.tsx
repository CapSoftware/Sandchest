import { PageSkeleton } from "@/components/app/skeleton";

/** A feed to measure the first skeleton from, before a scan has been seen on this browser. */
const SAMPLE_FEED = ["Cloning the repository", "Mapping entry points", "Following request handlers into the data layer", "Checking each path"];

/** Shown the instant a link is followed, until the scan arrives. */
export default function Loading() {
  return (
    <PageSkeleton id="scan" label="Loading scan">
      <nav className="crumbs">
        <span>Repos</span>
        <span>/</span>
        <span>acme/api</span>
      </nav>
      <div className="page-head">
        <div>
          <h1 className="page-title">Deep scan</h1>
          <p className="page-sub">
            Finished on <code>the default branch</code>
          </p>
        </div>
      </div>
      <dl className="stats">
        {["Took", "Findings", "Lines read"].map((label) => (
          <div key={label} className="stat">
            <dt>{label}</dt>
            <dd>12</dd>
          </div>
        ))}
      </dl>
      <section className="block">
        <h2 className="block-title">Log</h2>
        <div className="feed">
          <ol className="feed-lines">
            {SAMPLE_FEED.map((message) => (
              <li key={message} className="feed-line">
                <span className="feed-time">00:12</span>
                <span className="feed-message">{message}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </PageSkeleton>
  );
}
