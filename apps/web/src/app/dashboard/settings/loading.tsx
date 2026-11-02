import { PageSkeleton } from "@/components/app/skeleton";

/** Shown the instant a link is followed, until the settings arrive. */
export default function Loading() {
  return (
    <PageSkeleton id="settings" label="Loading settings">
      <div className="page-head">
        <h1 className="page-title">Settings</h1>
        <span className="key key-secondary">
          <span className="key-face">Add repositories</span>
        </span>
      </div>
      <section className="account">
        <div>
          <h2 className="account-name">acme</h2>
          <p className="account-role">You’re an admin</p>
        </div>
        <div className="settings-form">
          {["Checks", "Hacker", "Repositories"].map((legend) => (
            <div key={legend}>
              <p className="field-legend">{legend}</p>
              <p className="field-help">Which pull requests are reviewed, and who hears about what is found.</p>
            </div>
          ))}
        </div>
      </section>
      <section className="account">
        <div>
          <h2 className="account-name">octocat</h2>
          <p className="account-role">Signed in with GitHub</p>
        </div>
        <span className="key key-secondary">
          <span className="key-face">Sign out</span>
        </span>
      </section>
    </PageSkeleton>
  );
}
