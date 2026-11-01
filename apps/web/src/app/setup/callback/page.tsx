import { convertManifest, envBlock, ManifestError, type CreatedApp } from "@sandchest/github/manifest";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { CopyText } from "@/components/app/copy-text";
import { SetupShell } from "@/components/app/setup-shell";
import { githubApiUrl, SETUP_COOKIE, sessionValid, setupNeeded, stateValid } from "@/server/setup";
import "../../app.css";

export const metadata: Metadata = { title: "Your GitHub App · Sandchest", referrer: "no-referrer", robots: { index: false, follow: false } };

/**
 * Where GitHub sends the operator after creating the App. The code is
 * exchanged here, once (GitHub refuses a second exchange), and the keys are
 * shown in this response only: nothing is logged or stored, and the page is
 * never cached, so reloading it cannot show them again.
 */
export default async function SetupCallbackPage({ searchParams }: { searchParams: Promise<{ code?: string; state?: string }> }) {
  const [jar, { code, state }] = await Promise.all([cookies(), searchParams]);
  if (!setupNeeded()) notFound();

  if (!sessionValid(jar.get(SETUP_COOKIE)?.value) || !stateValid(state)) {
    return (
      <Problem title="Start again.">
        This link has expired or was opened in a different browser from the one that started setup. If GitHub created the App, delete it first (Settings, Developer settings, GitHub Apps), then
        start setup again.
      </Problem>
    );
  }
  if (typeof code !== "string" || !code) return <Problem title="Start again.">GitHub didn’t send a code back. Start setup again.</Problem>;

  let app: CreatedApp;
  try {
    app = await convertManifest(code, { baseUrl: githubApiUrl() });
  } catch (error) {
    const status = error instanceof ManifestError ? error.status : 0;
    console.error(`Setup: converting the GitHub App manifest failed${status ? ` (GitHub ${status})` : ""}`);
    return (
      <Problem title={status === 404 || status === 422 ? "Already shown." : "GitHub didn’t answer."}>
        {status === 404 || status === 422
          ? "GitHub hands over an App’s keys once, within an hour of creating it, and this code has been used or has expired. If you didn’t save them, open the App’s settings on GitHub: generate a new private key and client secret, set a webhook secret, and add them to the environment as setup describes."
          : "Sandchest couldn’t get the App’s keys from GitHub. Reload this page within the hour to try again."}
      </Problem>
    );
  }
  console.log(`Setup: GitHub App ${app.id} created. Its keys were shown once and not stored.`);

  const block = envBlock(app);
  return (
    <SetupShell title="Your GitHub App is ready.">
      <p className="sign-in-body">
        These are its keys, shown this once and stored nowhere on this server. Add them to the server’s environment: for Docker, the <code>.env</code> file next to{" "}
        <code>compose.yml</code>.
      </p>
      <pre className="poc setup-env" aria-label="Environment variables" tabIndex={0}>
        {block}
      </pre>
      <div className="form-foot setup-copy">
        <CopyText text={`${block}\n`} label="Copy all" />
      </div>
      <ol className="setup-steps">
        <li>
          Paste them into <code>.env</code>, then run <code>docker compose up -d</code> to restart with them. On another host, add them as environment variables and redeploy.
        </li>
        <li>
          Install the App on the repositories to review:{" "}
          <a href={`https://github.com/apps/${app.slug}/installations/new`} rel="noreferrer">
            github.com/apps/{app.slug}
          </a>
          .
        </li>
        <li>
          Sign in at <a href="/sign-in">/sign-in</a>. A threat model for each repository is built first; pull requests are reviewed from then on.
        </li>
      </ol>
      <p className="sign-in-note">
        Lost them?{" "}
        <a href={app.settingsUrl} rel="noreferrer">
          The App’s settings on GitHub
        </a>{" "}
        can generate a new private key and client secret, and set a new webhook secret.
      </p>
    </SetupShell>
  );
}

function Problem({ title, children }: { title: string; children: string }) {
  return (
    <SetupShell title={title}>
      <p className="sign-in-body">{children}</p>
      <a className="key key-secondary setup-cta" href="/setup">
        <span className="key-face">Back to setup</span>
      </a>
    </SetupShell>
  );
}
