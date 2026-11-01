import { settingsOrgs, type SettingsOrg } from "@sandchest/db";
import type { Metadata } from "next";
import { Avatar } from "@/components/app/avatar";
import { OrgSettingsForm } from "@/components/app/org-settings";
import { InstallKey } from "@/components/app/install-key";
import { viewer } from "@/server/access";
import { signOut } from "@/server/actions";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Settings · Sandchest" };

/** Where an installation's repository choice is changed on GitHub. */
function installationUrl(org: SettingsOrg): string {
  return org.type === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(org.login)}/settings/installations/${org.installationId}`
    : `https://github.com/settings/installations/${org.installationId}`;
}

export default async function SettingsPage() {
  const user = await viewer();
  const orgs = await settingsOrgs(db(), user.id);
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Settings</h1>
        <InstallKey secondary />
      </div>

      {orgs.length === 0 && (
        <div className="empty">
          <h2 className="empty-title">No accounts yet</h2>
          <p>Settings belong to each GitHub account Sandchest is installed on. Install it to get started.</p>
          <InstallKey />
        </div>
      )}

      {orgs.map((org) => (
        <section key={org.id} className="account" aria-labelledby={`org-${org.id}`}>
          <div>
            <h2 id={`org-${org.id}`} className="account-name">
              <Avatar src={`https://avatars.githubusercontent.com/${encodeURIComponent(org.login)}`} />
              {org.login}
            </h2>
            <p className="account-role">{org.admin ? "You’re an admin" : "Only admins can change these"}</p>
          </div>
          <div className="settings-form">
            <OrgSettingsForm orgId={org.id} threshold={org.settings.checkThreshold} email={org.settings.emailNotifications !== false} admin={org.admin} />
            <div>
              <p className="field-legend">Repositories</p>
              <p className="field-help">
                {org.repos.length === 0 ? "None you can push to." : "The ones you can push to."}{" "}
                {org.admin && (
                  <a className="quiet" href={installationUrl(org)}>
                    Choose repositories on GitHub
                  </a>
                )}
              </p>
              {org.repos.length > 0 && (
                <ul className="repo-list">
                  {org.repos.map((repo) => (
                    <li key={repo.id}>
                      {repo.fullName}
                      {!repo.private && <span className="tag">public</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      ))}

      <section className="account" aria-labelledby="you">
        <div>
          <h2 id="you" className="account-name">
            <Avatar src={user.image} />
            {user.login ?? user.name}
          </h2>
          <p className="account-role">Signed in with GitHub</p>
        </div>
        <form action={signOut}>
          <button type="submit" className="key key-secondary">
            <span className="key-face">Sign out</span>
          </button>
        </form>
      </section>
    </>
  );
}
