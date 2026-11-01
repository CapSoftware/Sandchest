/** Shown while a dashboard's numbers load. Only operators get this far: the layout checks first. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <span className="skeleton skeleton-title" />
      <span className="skeleton skeleton-line" style={{ width: "40%" }} />
      <span className="skeleton admin-skeleton-stats" />
      <span className="skeleton admin-skeleton-chart" />
    </div>
  );
}
