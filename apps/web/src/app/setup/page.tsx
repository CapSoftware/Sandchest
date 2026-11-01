import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";
import { SetupForm } from "@/components/app/setup-form";
import { SetupShell } from "@/components/app/setup-shell";
import { appUrl, newState, SETUP_COOKIE, sessionValid, setupNeeded, setupOrigin, setupToken } from "@/server/setup";
import "../app.css";

export const metadata: Metadata = { title: "Set up · Sandchest", referrer: "no-referrer", robots: { index: false, follow: false } };

const ASKS = [
  ["Read code", "Clones each repository into a temporary workspace for a scan."],
  ["Write pull request reviews", "Comments on the lines that let an attacker in."],
  ["Write checks", "The Sandchest check on every pull request."],
  ["Read issues", "Hears “/sandchest review” comments on pull requests."],
  ["Read organisation members", "Knows who administers an organisation, for its settings."],
  ["Read email addresses", "Emails people about critical findings."],
] as const;

/**
 * First run: creates this server's GitHub App from a manifest. Exists only
 * while no App is configured, and opens only with the setup token.
 */
export default async function SetupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const [jar, requestHeaders, { error }] = await Promise.all([cookies(), headers(), searchParams]);
  if (!setupNeeded()) notFound();

  const base = appUrl();
  if (!base || !setupToken()) {
    return (
      <SetupShell title="Almost there.">
        <p className="sign-in-body">Setup needs two settings in this server’s environment first. Add them, then restart it.</p>
        <ul className="setup-list">
          {!base && <li><code>SANDCHEST_APP_URL</code>: the public address GitHub reaches this server on, like https://sandchest.example.com.</li>}
          {!setupToken() && <li><code>BETTER_AUTH_SECRET</code>: 32 or more random characters (<code>openssl rand -hex 32</code>).</li>}
        </ul>
      </SetupShell>
    );
  }

  if (!sessionValid(jar.get(SETUP_COOKIE)?.value)) {
    return (
      <SetupShell title="Connect GitHub.">
        <p className="sign-in-body">
          This server needs a GitHub App of its own before it can review pull requests. To show you run it, open the setup link it printed when it started:
        </p>
        <pre className="poc setup-command">docker compose logs web | grep setup</pre>
        {error === "token" && <p className="notice">That token doesn’t match. Copy it again from the log.</p>}
        <form method="post" action="/setup/unlock" className="inline-form setup-unlock">
          <label className="text-field">
            <span className="text-field-label">Or paste the token from that link</span>
            <input name="token" type="password" required autoComplete="off" spellCheck={false} />
          </label>
          <button type="submit" className="key key-primary">
            <span className="key-face">Continue</span>
          </button>
        </form>
      </SetupShell>
    );
  }

  const origin = setupOrigin(requestHeaders, base);
  if (!origin.ok) {
    return (
      <SetupShell title="Wrong address.">
        <p className="sign-in-body">
          GitHub sends you back to this server’s public address after it creates the App, so start there. It is set to {base}.
        </p>
        <a className="key key-primary key-large key-glow setup-cta" href={origin.setupUrl}>
          <span className="key-face">Open setup at {new URL(base).host}</span>
        </a>
      </SetupShell>
    );
  }

  return (
    <SetupShell title="Create your GitHub App.">
      <p className="sign-in-body">
        Sandchest reviews pull requests as a GitHub App that you own. GitHub creates it from these settings and asks you to confirm. Then this page shows its keys, once.
      </p>
      <SetupForm appUrl={base} redirectUrl={origin.redirectUrl} state={newState()} />
      <section className="setup-asks" aria-labelledby="asks-title">
        <h2 id="asks-title" className="field-legend">
          What it asks GitHub for
        </h2>
        <dl className="setup-dl">
          {ASKS.map(([what, why]) => (
            <div key={what}>
              <dt>{what}</dt>
              <dd>{why}</dd>
            </div>
          ))}
          <div>
            <dt>Events</dt>
            <dd>Pull requests, pushes and comments. GitHub always sends installs.</dd>
          </div>
          <div>
            <dt>Webhooks go to</dt>
            <dd>
              <code>{base}/api/github/webhooks</code>
            </dd>
          </div>
        </dl>
      </section>
    </SetupShell>
  );
}
