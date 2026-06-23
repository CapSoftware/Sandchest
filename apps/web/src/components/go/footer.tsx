const cells = [
  { label: "GitHub", href: "https://github.com/CapSoftware/Sandchest" },
  { label: "Changelog", href: "#" },
  { label: "Discord", href: "#" },
  { label: "X", href: "#" },
];

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="flex divide-x divide-line border-b border-line">
        {cells.map((cell) => (
          <a
            key={cell.label}
            href={cell.href}
            className="link-muted flex-1 py-4 text-center text-sm"
          >
            {cell.label}
          </a>
        ))}
      </div>

      <div className="gutter flex flex-col items-start justify-between gap-3 py-5 text-xs text-muted sm:flex-row sm:items-center">
        <span>&copy; 2026 Sandchest. Open source.</span>
        <div className="flex items-center gap-5">
          <a href="#" className="link-muted">
            Privacy
          </a>
          <a href="#" className="link-muted">
            Terms
          </a>
          <a href="#" className="link-muted">
            Status
          </a>
        </div>
      </div>
    </footer>
  );
}
