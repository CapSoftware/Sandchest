import { pendingDeviceGrant, settingsOrgs } from "@sandchest/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AgentAbilities } from "@/components/app/agent-consent";
import { InstallKey } from "@/components/app/install-key";
import { SetupShell } from "@/components/app/setup-shell";
import { currentUser } from "@/server/access";
import { decideDevice } from "@/server/agent-actions";
import { formatUserCode, normaliseUserCode } from "@/server/agent/tokens";
import { db } from "@/server/db";
import "../app.css";

// "same-origin", not "no-referrer": the URL (with its code) still never leaves the site, but a button pressed
// before the page's script loads posts a plain form, and under no-referrer the browser sends `Origin: null`,
// which Next refuses as a cross-site Server Action.
export const metadata: Metadata = { title: "Connect an agent · Sandchest", referrer: "same-origin", robots: { index: false, follow: false } };

/**
 * Where a person approves an agent that asked to connect with the device
 * flow: the agent shows them a code and this link. Approving gives the agent
 * an API key that acts as them.
 */
export default async function DevicePage({ searchParams }: { searchParams: Promise<{ code?: string; done?: string; error?: string }> }) {
  const params = await searchParams;
  const user = await currentUser();
  if (!user) {
    const next = `/device${params.code ? `?code=${encodeURIComponent(params.code)}` : ""}`;
    redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  }

  if (params.done === "approved") {
    const accounts = await settingsOrgs(db(), user.id);
    return (
      <SetupShell title="Agent connected.">
        <p className="sign-in-body">Go back to your agent: it takes it from here.</p>
        {accounts.length === 0 && (
          <>
            <p className="sign-in-body">One thing only you can do: install Sandchest on GitHub and choose the repositories it may read. Your agent sees them as soon as you’re done.</p>
            <div className="setup-cta">
              <InstallKey />
            </div>
          </>
        )}
        <p className="sign-in-note">
          Disconnect it any time from <a href="/dashboard/settings#agents">Settings</a>.
        </p>
      </SetupShell>
    );
  }
  if (params.done === "denied") {
    return (
      <SetupShell title="Denied.">
        <p className="sign-in-body">The agent wasn’t connected and got nothing. You can close this tab.</p>
      </SetupShell>
    );
  }

  const code = normaliseUserCode(params.code);
  const grant = code ? await pendingDeviceGrant(db(), code) : undefined;
  if (!code || !grant) {
    return (
      <SetupShell title="Connect an agent.">
        <p className="sign-in-body">Enter the code your agent showed you.</p>
        {(params.error || (params.code && !grant)) && <p className="notice">That code has expired, was already used, or isn’t right. Ask your agent for a new one.</p>}
        <form method="get" action="/device" className="inline-form setup-unlock">
          <label className="text-field">
            <span className="text-field-label">Code</span>
            <input name="code" required autoComplete="off" spellCheck={false} placeholder="BCDF-GHJK" maxLength={12} />
          </label>
          <button type="submit" className="key key-primary" data-track="device-continue">
            <span className="key-face">Continue</span>
          </button>
        </form>
      </SetupShell>
    );
  }

  return (
    <SetupShell title="Connect an agent?">
      <p className="sign-in-body">
        <strong>{grant.clientName}</strong> wants to use Sandchest as <strong>{user.login ?? user.name}</strong>. Check your agent shows this code:
      </p>
      <p className="agent-code">{formatUserCode(code)}</p>
      <AgentAbilities />
      <div className="agent-decide">
        <form action={decideDevice.bind(null, code, true)}>
          <button type="submit" className="key key-primary key-large key-glow" data-track="device-approve">
            <span className="key-face">Connect</span>
          </button>
        </form>
        <form action={decideDevice.bind(null, code, false)}>
          <button type="submit" className="key key-secondary key-large" data-track="device-deny">
            <span className="key-face">Deny</span>
          </button>
        </form>
      </div>
      <p className="sign-in-note">Only connect agents you started yourself. Never approve a code someone sent you.</p>
    </SetupShell>
  );
}
