/** Shown the instant a link is followed, until the page's data arrives. */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <span className="skeleton skeleton-title" />
      <span className="skeleton skeleton-line" style={{ width: "40%" }} />
      <div className="rows" style={{ marginTop: "2.5rem" }}>
        {[72, 64, 80, 58].map((width) => (
          <span key={width} className="skeleton skeleton-line" style={{ width: `${width}%` }} />
        ))}
      </div>
    </div>
  );
}
