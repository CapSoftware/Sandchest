"use client";
import { useState } from "react";
import { APP_NAME_MAX, buildManifest, GITHUB_LOGIN, manifestFormAction } from "@sandchest/github/manifest";

/**
 * Posts the App's manifest straight to GitHub, where the operator confirms.
 * Without JavaScript it still works, for a personal account with the defaults.
 */
export function SetupForm({ appUrl, redirectUrl, state }: { appUrl: string; redirectUrl: string; state: string }) {
  const [owner, setOwner] = useState<"user" | "org">("user");
  const [org, setOrg] = useState("");
  const [name, setName] = useState("Sandchest");
  const [visibility, setVisibility] = useState<"private" | "public">("private");

  const orgValid = GITHUB_LOGIN.test(org);
  const action = manifestFormAction(owner === "org" && orgValid ? { kind: "org", org } : { kind: "user" }, state);
  const manifest = buildManifest({ appUrl, redirectUrl, name, public: visibility === "public" });

  return (
    <form method="post" action={action} className="settings-form setup-form">
      <input type="hidden" name="manifest" value={JSON.stringify(manifest)} />
      <fieldset>
        <legend className="field-legend">Owner</legend>
        <p className="field-help">The account the App belongs to. For an organisation you need to be one of its owners.</p>
        <div className="segments">
          <label className="segment">
            <input type="radio" name="owner" value="user" checked={owner === "user"} onChange={() => setOwner("user")} />
            <span>Your account</span>
          </label>
          <label className="segment">
            <input type="radio" name="owner" value="org" checked={owner === "org"} onChange={() => setOwner("org")} />
            <span>An organisation</span>
          </label>
        </div>
        {owner === "org" && (
          <label className="text-field">
            <span className="text-field-label">Organisation</span>
            <input
              name="org"
              value={org}
              onChange={(event) => setOrg(event.target.value.trim())}
              required
              pattern={GITHUB_LOGIN.source}
              maxLength={39}
              autoComplete="off"
              spellCheck={false}
              placeholder="acme"
              aria-describedby="org-help"
            />
            <span id="org-help" className="field-help">
              {org && !orgValid ? "That isn’t a GitHub organisation name." : "As it appears in github.com/acme."}
            </span>
          </label>
        )}
      </fieldset>
      <fieldset>
        <legend className="field-legend">Name</legend>
        <p className="field-help">Names are unique on GitHub. If this one is taken, change it on GitHub’s page.</p>
        <label className="text-field">
          <span className="sr-only">App name</span>
          <input name="name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={APP_NAME_MAX} autoComplete="off" spellCheck={false} />
        </label>
      </fieldset>
      <fieldset>
        <legend className="field-legend">Who can install it</legend>
        <p className="field-help">Keep it to the owner unless you run Sandchest as a service for other accounts.</p>
        <div className="segments">
          <label className="segment">
            <input type="radio" name="visibility" value="private" checked={visibility === "private"} onChange={() => setVisibility("private")} />
            <span>Only the owner</span>
          </label>
          <label className="segment">
            <input type="radio" name="visibility" value="public" checked={visibility === "public"} onChange={() => setVisibility("public")} />
            <span>Any account</span>
          </label>
        </div>
      </fieldset>
      <div className="form-foot">
        <button type="submit" className="key key-primary key-large key-glow" disabled={owner === "org" && !orgValid}>
          <span className="key-face">Create on GitHub</span>
        </button>
        <span>
          GitHub sends you back to <code>{redirectUrl}</code>.
        </span>
      </div>
    </form>
  );
}
