import type { OrgBillingRow, SettingsOrg, userAgentAccess } from "@sandchest/db";
import { AgentPromptButton } from "@/components/agent-prompt-button";
import { CreateKeyForm } from "@/components/app/agent-keys";
import { Avatar } from "@/components/app/avatar";
import { BillingPanel } from "@/components/app/billing-panel";
import { Link } from "@/components/app/hover-link";
import { InstallKey } from "@/components/app/install-key";
import { OrgSettingsForm } from "@/components/app/org-settings";
import { ForgetShapesForm } from "@/components/app/skeleton";
import { timeAgo } from "@/lib/format";
import { readHacker } from "@/lib/hacker";
import { signOut } from "@/server/actions";
import { revokeKey } from "@/server/key-actions";

/** Where an installation's repository choice is changed on GitHub. */
function installationUrl(org: SettingsOrg): string {
  return org.type === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(org.login)}/settings/installations/${org.installationId}`
    : `https://github.com/settings/installations/${org.installationId}`;
}

/** Agents and API keys connected to the person. */
export type AgentAccess = Awaited<ReturnType<typeof userAgentAccess>>;

/**
 * Settings, drawn from what the page read; its loading state draws them from a sample account. `billing` is each
 * org's, or null with billing off; `appUrl` is where agents reach the MCP server.
 */
export function SettingsView({
  user,
  orgs,
  billing,
  access,
  appUrl,
}: {
  user: { image: string | null; login: string | null; name: string };
  orgs: SettingsOrg[];
  billing: Array<OrgBillingRow | null> | null;
  access: AgentAccess;
  appUrl: string;
}) {
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

      <div id="billing" />
      {orgs.map((org, index) => (
        <section key={org.id} className="account" aria-labelledby={`org-${org.id}`}>
          <div>
            <h2 id={`org-${org.id}`} className="account-name">
              <Avatar src={`https://avatars.githubusercontent.com/${encodeURIComponent(org.login)}`} />
              {org.login}
            </h2>
            <p className="account-role">{org.admin ? "You’re an admin" : "Only admins can change these"}</p>
          </div>
          <div className="settings-form">
            {billing && <BillingPanel org={org} billing={billing[index] ?? null} />}
            <OrgSettingsForm orgId={org.id} threshold={org.settings.checkThreshold} email={org.settings.emailNotifications !== false} admin={org.admin} />
            <div>
              <p className="field-legend">Hacker</p>
              <p className="field-help">
                {readHacker(org.settings.hacker).handle} works for {org.login}.{" "}
                <Link className="quiet" href={`/dashboard/hacker?org=${org.id}`}>
                  {org.admin ? `Customize ${readHacker(org.settings.hacker).handle}` : `Visit ${readHacker(org.settings.hacker).handle}`}
                </Link>
              </p>
            </div>
            <div>
              <p className="field-legend">Repositories</p>
              <p className="field-help">
                {org.repos.length === 0 ? "None you can push to." : "The ones you can push to."}{" "}
                {/* On Forgejo the operator chooses repositories, in FORGEJO_OWNERS. */}
                {org.admin && org.provider === "github" && (
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

      <section id="agents" className="account" aria-labelledby="agents-title">
        <div>
          <h2 id="agents-title" className="account-name">
            Agents
          </h2>
          <p className="account-role">Everything here works from your coding agent too</p>
        </div>
        <div className="settings-form">
          <div>
            <p className="field-legend">Connect an agent</p>
            <p className="field-help">
              Paste this prompt into Claude Code, Cursor, Codex or any agent, and it connects itself: you approve it once. Or add the MCP server{" "}
              <code>{`${appUrl}/api/mcp`}</code> to your agent. <Link className="quiet" href="/docs/agents">How agents use Sandchest</Link>
            </p>
            <AgentPromptButton className="key key-primary" track="settings-agent-prompt" label="Copy prompt for your agent" />
          </div>
          <div>
            <p className="field-legend">Connected agents and API keys</p>
            {access.length === 0 ? (
              <p className="field-help">None yet.</p>
            ) : (
              <ul className="repo-list agent-list">
                {access.map((row) => (
                  <li key={row.id}>
                    <span>
                      {row.name}
                      <span className="tag">{row.kind === "key" ? `key ${row.prefix}…` : "MCP"}</span>
                    </span>
                    <span className="field-help">{row.lastUsedAt ? `Last used ${timeAgo(row.lastUsedAt)}` : "Never used"}</span>
                    <form action={revokeKey.bind(null, row.id)}>
                      <button type="submit" className="quiet" data-track="api-key-revoke">
                        {row.kind === "key" ? "Revoke" : "Disconnect"}
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="field-legend">New API key</p>
            <p className="field-help">For CI or scripts: send it as <code>Authorization: Bearer &lt;key&gt;</code> to the API. It acts as you.</p>
            <CreateKeyForm />
          </div>
        </div>
      </section>

      <section className="account" aria-labelledby="you">
        <div>
          <h2 id="you" className="account-name">
            <Avatar src={user.image} />
            {user.login ?? user.name}
          </h2>
          <p className="account-role">Signed in with GitHub</p>
        </div>
        <ForgetShapesForm action={signOut}>
          <button type="submit" className="key key-secondary" data-track="sign-out">
            <span className="key-face">Sign out</span>
          </button>
        </ForgetShapesForm>
      </section>
    </>
  );
}
