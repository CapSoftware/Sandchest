/**
 * The hero's second key, beside the gold one: a dark key of the same size
 * that leads to the demo. Pointed at, its outline lights gold and a scan
 * line sweeps down its face.
 */
export function DemoKey({ href, track }: { href: string; track?: string }) {
  return (
    <a href={href} className="button button-hero demo-key" data-track={track}>
      <span className="button-face">
        <span className="demo-key-play" aria-hidden="true">
          <svg width="8" height="14" viewBox="0 0 4 7" shapeRendering="crispEdges">
            <path fill="currentColor" d="M0 0h1v7H0zM1 1h1v5H1zM2 2h1v3H2zM3 3h1v1H3z" />
          </svg>
        </span>
        Try the live demo
      </span>
    </a>
  );
}
