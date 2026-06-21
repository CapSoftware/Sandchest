import Link from "next/link";

const navItems = ["Overview", "Sandboxes", "Settings"];

const tiles = [
  {
    title: "Workspace",
    body: "A clean place for the next version of Sandchest.",
  },
  {
    title: "Runtime",
    body: "Next.js App Router running inside a Turborepo workspace.",
  },
  {
    title: "Status",
    body: "Ready for the first real feature to land.",
  },
];

export default function Home() {
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary navigation">
        <div className="brand">
          <span className="brand-mark">S</span>
          <span>Sandchest</span>
        </div>
        <nav className="nav">
          {navItems.map((item, index) => (
            <Link
              aria-current={index === 0 ? "page" : undefined}
              href="/"
              key={item}
            >
              {item}
            </Link>
          ))}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <strong>Sandchest</strong>
          <span className="status">Local shell</span>
        </header>

        <section className="content">
          <p className="eyebrow">Scratch app</p>
          <h1>Build from a clean foundation.</h1>
          <p className="summary">
            Sandchest is reset to a small web app shell with the monorepo
            plumbing in place and no legacy platform code attached.
          </p>

          <div className="grid">
            {tiles.map((tile) => (
              <section className="tile" key={tile.title}>
                <strong>{tile.title}</strong>
                <span>{tile.body}</span>
              </section>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
