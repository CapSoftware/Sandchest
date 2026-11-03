import { PageSkeleton } from "@/components/app/skeleton";

/** Shown the instant a link is followed, until the repo arrives. */
export default function Loading() {
  return (
    <PageSkeleton id="repo" label="Loading repository">
      <nav className="crumbs">
        <a>Repos</a>
        <span aria-hidden="true">/</span>
        <span>acme</span>
      </nav>
      <div className="page-head">
        <div>
          <h1 className="page-title">billing-api</h1>
          <p className="page-sub">acme/billing-api · private · GitHub</p>
        </div>
        <span className="key key-primary">
          <span className="key-face">Deep scan</span>
        </span>
      </div>
      <dl className="stats">
        {["Open findings", "Reviews, 30 days", "Last deep scan", "Lines of code"].map((label) => (
          <div key={label} className="stat">
            <dt>{label}</dt>
            <dd>12</dd>
          </div>
        ))}
      </dl>
      <h2 className="block-title">Open findings</h2>
      <div style={{ height: "12rem" }} />
    </PageSkeleton>
  );
}
