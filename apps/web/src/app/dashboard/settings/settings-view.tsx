import type { OrgBillingRow, SettingsOrg, UsageHistoryRow, userAgentAccess } from "@sandchest/db";
import type { ReactNode } from "react";
import { AgentPromptButton } from "@/components/agent-prompt-button";
import { CreateKeyForm } from "@/components/app/agent-keys";
import { Avatar } from "@/components/app/avatar";
import { BillingPanel } from "@/components/app/billing-panel";
import { Link } from "@/components/app/hover-link";
import { InstallKey } from "@/components/app/install-key";
import { OrgReviewsForm } from "@/components/app/org-reviews";
import { OrgSettingsForm } from "@/components/app/org-settings";
import { ForgetShapesForm } from "@/components/app/skeleton";
import { LeaveTeam, TeamPanel, type TeamRow } from "@/components/app/team";
import { UsageHistory } from "@/components/app/usage-history";
import { timeAgo } from "@/lib/format";
import { readHacker } from "@/lib/hacker";
import { signOut } from "@/server/actions";
import { revokeKey } from "@/server/key-actions";

/**
 * Settings, a tab at a time. Each view draws what its page read; its loading
 * state draws the same view from a sample account.
 */

/** Where an installation's repository choice is changed on GitHub. */
function installationUrl(org: SettingsOrg): string {
  return org.type === "Organization"
    ? `https://github.com/organizations/${encodeURIComponent(org.login)}/settings/installations/${org.installationId}`
    : `https://github.com/settings/installations/${org.installationId}`;
}

/** Agents and API keys connected to the person. */
export type AgentAccess = Awaited<ReturnType<typeof userAgentAccess>>;

function NoAccounts() {
  return (
    <div className="empty">
      <h2 className="empty-title">No accounts yet</h2>
      <p>Settings belong to each GitHub account Sandchest is installed on. Install it to get started.</p>
      <InstallKey />
    </div>
  );
}

/** One account's part of a tab: its name and your role beside it, the tab's controls for it on the right. */
function Account({ org, role, children }: { org: SettingsOrg; role?: string; children: ReactNode }) {
  return (
    <section className="account" aria-labelledby={`org-${org.id}`}>
      <div>
        <h2 id={`org-${org.id}`} className="account-name">
          <Avatar src={`https://avatars.githubusercontent.com/${encodeURIComponent(org.login)}`} />
          {org.login}
        </h2>
        <p className="account-role">{role ?? (org.admin ? "You’re an admin" : "Only admins can change these")}</p>
      </div>
      <div className="settings-form">{children}</div>
    </section>
  );
}

/** General: how pull requests are reviewed and checked, emails, and the hacker. */
export function GeneralView({ orgs }: { orgs: SettingsOrg[] }) {
  if (orgs.length === 0) return <NoAccounts />;
  return orgs.map((org) => {
    const hacker = readHacker(org.settings.hacker).handle;
    return (
      <Account key={org.id} org={org}>
        <OrgReviewsForm orgId={org.id} mode={org.settings.prReviewsDefault ?? "auto"} admin={org.admin} />
        <OrgSettingsForm orgId={org.id} threshold={org.settings.checkThreshold} email={org.settings.emailNotifications !== false} admin={org.admin} />
        <div>
          <p className="field-legend">Hacker</p>
          <p className="field-help">
            {hacker} works for {org.login}.{" "}
            <Link className="quiet" href={`/dashboard/hacker?org=${org.id}`}>
              {org.admin ? `Customize ${hacker}` : `Visit ${hacker}`}
            </Link>
          </p>
        </div>
      </Account>
    );
  });
}

/** Team: who has access to each account; admins invite and manage, invited people can leave. */
export function TeamView({ orgs, teams, memberOf }: { orgs: SettingsOrg[]; teams: Record<string, TeamRow[]>; memberOf: string[] }) {
  if (orgs.length === 0) return <NoAccounts />;
  return orgs.map((org) => (
    <Account key={org.id} org={org} role={org.admin ? "You’re an admin" : memberOf.includes(org.id) ? "You joined by invite" : "Only admins manage the team"}>
      {org.admin ? (
        <TeamPanel orgId={org.id} org={org.login} rows={teams[org.id] ?? []} />
      ) : memberOf.includes(org.id) ? (
        <LeaveTeam orgId={org.id} org={org.login} />
      ) : (
        <div>
          <p className="field-legend">Team</p>
          <p className="field-help">You see {org.login}’s repositories because you can push to them on GitHub. An admin of {org.login} can invite anyone else.</p>
        </div>
      )}
    </Account>
  ));
}

/** Billing: each account's plan, credits and auto top-up. */
/** Billing: each account's plan and credits, and its recent usage bills when it has any. `usage` is by account id. */
export function BillingView({ orgs, billing, usage }: { orgs: SettingsOrg[]; billing: Array<OrgBillingRow | null>; usage?: Record<string, UsageHistoryRow[]> }) {
  if (orgs.length === 0) return <NoAccounts />;
  return orgs.map((org, index) => {
    const bills = usage?.[org.id] ?? [];
    return (
      <Account key={org.id} org={org}>
        <BillingPanel org={org} billing={billing[index] ?? null} />
        {bills.length > 0 && <UsageHistory rows={bills} />}
      </Account>
    );
  });
}

/** Repositories: what Sandchest can read in each account, and where that's chosen. */
export function RepositoriesView({ orgs, memberOf }: { orgs: SettingsOrg[]; memberOf: string[] }) {
  if (orgs.length === 0) return <NoAccounts />;
  return orgs.map((org) => (
    <Account key={org.id} org={org} role={`${org.repos.length} ${org.repos.length === 1 ? "repository" : "repositories"}`}>
      <div>
        <p className="field-legend">Repositories</p>
        <p className="field-help">
          {org.repos.length === 0 ? "None you can see." : memberOf.includes(org.id) ? "All of them: you joined by invite." : "The ones you can push to."}{" "}
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
    </Account>
  ));
}

/** Agents: connecting a coding agent, and the keys and clients already connected. `appUrl` is where agents reach the MCP server. */
export function AgentsView({ access, appUrl }: { access: AgentAccess; appUrl: string }) {
  return (
    <section className="account" aria-labelledby="agents-title">
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
            Paste this prompt into Claude Code, Cursor, Codex or any agent, and it connects itself: you approve it once. Or add the MCP server <code>{`${appUrl}/api/mcp`}</code> to your
            agent.{" "}
            <Link className="quiet" href="/docs/agents">
              How agents use Sandchest
            </Link>
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
          <p className="field-help">
            For CI or scripts: send it as <code>Authorization: Bearer &lt;key&gt;</code> to the API. It acts as you.
          </p>
          <CreateKeyForm />
        </div>
      </div>
    </section>
  );
}

/** Account: who you're signed in as, and signing out. */
export function AccountView({ user }: { user: { image: string | null; login: string | null; name: string } }) {
  return (
    <section className="account" aria-labelledby="you">
      <div>
        <h2 id="you" className="account-name">
          <Avatar src={user.image} />
          {user.login ?? user.name}
        </h2>
        <p className="account-role">Signed in with GitHub</p>
      </div>
      <div className="settings-form">
        <div>
          <p className="field-legend">Sign out</p>
          <p className="field-help">Signs you out of Sandchest on this browser. Your agents and API keys stay connected until you revoke them.</p>
          <ForgetShapesForm action={signOut}>
            <button type="submit" className="key key-secondary" data-track="sign-out">
              <span className="key-face">Sign out</span>
            </button>
          </ForgetShapesForm>
        </div>
      </div>
    </section>
  );
}
