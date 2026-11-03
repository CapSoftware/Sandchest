import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AgentAbilities } from "@/components/app/agent-consent";
import { SetupShell } from "@/components/app/setup-shell";
import { currentUser } from "@/server/access";
import { decideAuthorize } from "@/server/agent-actions";
import { checkAuthorize } from "@/server/agent/oauth";
import "../../app.css";

// "same-origin", not "no-referrer": the URL (with its code) still never leaves the site, but a button pressed
// before the page's script loads posts a plain form, and under no-referrer the browser sends `Origin: null`,
// which Next refuses as a cross-site Server Action.
export const metadata: Metadata = { title: "Connect an app · Sandchest", referrer: "same-origin", robots: { index: false, follow: false } };

const KEYS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;

/** Where an MCP client (Claude Code, Cursor, Codex…) sends the person to approve it, the OAuth way. */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const params = Object.fromEntries(KEYS.map((key) => [key, typeof raw[key] === "string" ? raw[key] : undefined])) as Record<string, string | undefined>;
  const user = await currentUser();
  if (!user) {
    const query = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined));
    redirect(`/sign-in?next=${encodeURIComponent(`/oauth/authorize?${query}`)}`);
  }
  const checked = await checkAuthorize(params);
  if (!checked.ok) {
    // Never sent anywhere without a click: anyone can register a client, so its address isn't trusted.
    if ("redirect" in checked) {
      const back = new URL(checked.redirect);
      return (
        <SetupShell title="Can’t connect.">
          <p className="sign-in-body">{back.searchParams.get("error_description") ?? "This app’s request isn’t valid."} Nothing was shared.</p>
          <p className="sign-in-note">
            <a href={checked.redirect}>Return to {back.protocol === "http:" || back.protocol === "https:" ? back.host : back.protocol.replace(/:$/, "")}</a>
          </p>
        </SetupShell>
      );
    }
    return (
      <SetupShell title="Can’t connect.">
        <p className="sign-in-body">{checked.show}</p>
      </SetupShell>
    );
  }
  const { request } = checked;
  const back = new URL(request.redirectUri);
  const destination = back.protocol === "http:" || back.protocol === "https:" ? back.host : back.protocol.replace(/:$/, "");
  return (
    <SetupShell title="Connect an app?">
      <p className="sign-in-body">
        <strong>{request.clientName}</strong> wants to use Sandchest as <strong>{user.login ?? user.name}</strong>.
      </p>
      <AgentAbilities />
      <div className="agent-decide">
        <form action={decideAuthorize.bind(null, params, true)}>
          <button type="submit" className="key key-primary key-large key-glow" data-track="oauth-approve">
            <span className="key-face">Connect</span>
          </button>
        </form>
        <form action={decideAuthorize.bind(null, params, false)}>
          <button type="submit" className="key key-secondary key-large" data-track="oauth-deny">
            <span className="key-face">Deny</span>
          </button>
        </form>
      </div>
      <p className="sign-in-note">
        You’ll go back to <code>{destination}</code>. Disconnect it any time from <a href="/dashboard/settings#agents">Settings</a>.
      </p>
    </SetupShell>
  );
}
