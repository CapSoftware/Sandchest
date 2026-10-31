import { ChestStage } from "@/components/chest-stage";
import { FindingStrip } from "@/components/finding-strip";
import { HowItWorks } from "@/components/how-it-works";
import { site } from "@/lib/site";

const footerLinks = [
  { label: "Docs", href: site.links.docs },
  { label: "GitHub", href: site.githubUrl },
  { label: "Terms", href: site.links.terms },
  { label: "Privacy", href: site.links.privacy },
  { label: "Acceptable use", href: site.links.acceptableUse },
];

/** The GitHub mark, from GitHub's Octicons. */
function GitHubMark() {
  return (
    <svg className="button-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export default function Home() {
  return (
    <div className="page">
      <header className="site-header">
        <a href="/" className="wordmark" aria-label="Sandchest home">
          <img src="/sandchest-logo-dark.svg" alt="Sandchest" width={2382} height={473} />
        </a>
        <nav aria-label="Main" className="header-nav">
          <a href={site.links.docs}>Docs</a>
          <a href={site.githubUrl}>GitHub</a>
        </nav>
      </header>

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <h1 id="hero-title" className="hero-title">
            Add a hacker to your team.
          </h1>
          <p className="hero-lede">
            Sandchest acts like a real hacker embedded in your team, using abliterated,
            unrestricted models to find real vulnerabilities in your code before attackers do.
          </p>
          <div className="hero-actions">
            <a href={site.links.getStarted} className="button button-primary">
              <span className="button-face">Get started</span>
            </a>
            <a href={site.githubUrl} className="button button-secondary">
              <span className="button-face">
                <GitHubMark />
                View on GitHub
              </span>
            </a>
          </div>
        </section>

        <ChestStage />

        <section className="section" aria-labelledby="pitch-title">
          <h2 id="pitch-title" className="section-title">
            Find the exploit before someone else does
          </h2>
          <p className="pitch-body">
            Attackers already use abliterated models to scan code for holes. Sandchest runs the
            same models on your repos and sends you what it finds. Every finding comes with:
          </p>
          <ul className="pitch-list">
            <li>The attack path, step by step, with file and line</li>
            <li>A proof of concept you can run</li>
            <li>What the fix must guarantee, and what it mustn&rsquo;t break</li>
            <li>A ready-to-run prompt for your coding agent, with a regression test</li>
          </ul>
        </section>

        <HowItWorks />

        <section className="section" aria-labelledby="example-title">
          <h2 id="example-title" className="section-title">
            What a finding looks like
          </h2>
          <FindingStrip />
          <p className="strip-caption">An example. Identifying details are redacted.</p>
        </section>
      </main>

      <footer className="site-footer">
        <nav aria-label="Footer">
          <ul>
            {footerLinks.map((link) => (
              <li key={link.label}>
                <a href={link.href}>{link.label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <p>Open source under AGPL-3.0.</p>
      </footer>
    </div>
  );
}
