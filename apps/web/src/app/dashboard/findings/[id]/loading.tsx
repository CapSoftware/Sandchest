import { Heat } from "@/components/app/heat";
import { PageSkeleton } from "@/components/app/skeleton";

/** Shown the instant a link is followed, until the finding arrives. */
export default function Loading() {
  return (
    <PageSkeleton id="finding" label="Loading finding">
      <nav className="crumbs">
        <span>Findings</span>
        <span>/</span>
        <span>acme/api</span>
      </nav>
      <header className="finding-head">
        <div className="finding-rating">
          <Heat severity="high" label />
          <span>high confidence</span>
          <span>Access control</span>
          <span className="status" data-status="open">
            Open
          </span>
        </div>
        <h1 className="finding-title">Any signed-in user can read another account’s invoices</h1>
        <p className="finding-impact">An invoice id from any account returns that account’s invoice, with its line items and billing address, to whoever asks.</p>
      </header>
      <div className="finding-layout">
        <div>
          <section className="block">
            <h2 className="block-title">Attack path</h2>
            <ol className="path">
              {["src/routes/invoices.ts:42", "src/services/billing.ts:88", "src/db/invoices.ts:17"].map((at, i) => (
                <li key={at} className={i === 0 ? "hop hop-entry" : i === 2 ? "hop hop-sink" : "hop"}>
                  <div className="hop-at">
                    <a>{at}</a>
                  </div>
                  <p className="hop-note">The id from the URL is passed on without checking who owns it.</p>
                </li>
              ))}
            </ol>
          </section>
          <section className="block">
            <h2 className="block-title">Proof of concept</h2>
            <pre className="poc">{"curl -H 'Cookie: session=…' \\\n  https://app.example.com/api/invoices/42"}</pre>
          </section>
        </div>
        <aside className="finding-aside">
          <div className="decide">
            <div className="decide-row">
              <span className="key key-secondary">
                <span className="key-face">Mark fixed</span>
              </span>
              <span className="key key-secondary">
                <span className="key-face">Dismiss</span>
              </span>
            </div>
          </div>
          <dl className="facts">
            {["Who can exploit it", "Preconditions", "Found by", "First seen"].map((label) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>Any signed-in user</dd>
              </div>
            ))}
          </dl>
        </aside>
      </div>
    </PageSkeleton>
  );
}
