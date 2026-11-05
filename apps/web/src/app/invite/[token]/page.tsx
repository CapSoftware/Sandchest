import type { Metadata } from "next";
import { Avatar } from "@/components/app/avatar";
import { JoinTeamForm } from "@/components/app/join-team";
import { SetupShell } from "@/components/app/setup-shell";
import { currentUser } from "@/server/access";
import { signIn } from "@/server/actions";
import { authConfigured } from "@/server/auth";
import { inviteForLink } from "@/server/team";
import { switchAccount } from "@/server/team-actions";
import { maskEmail } from "@/lib/format";
import "../../app.css";

// "same-origin", not "no-referrer": the link's token never leaves the site, and a Join pressed before the page's
// script loads still posts with an Origin header (no-referrer sends `Origin: null`, which Next refuses).
export const metadata: Metadata = { title: "Join a team · Sandchest", referrer: "same-origin", robots: { index: false, follow: false } };

/** Where an invite's link lands: who invited you to what, then sign in and join. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [invite, user] = await Promise.all([inviteForLink(token), currentUser()]);
  const inviter = invite?.inviterLogin ? `@${invite.inviterLogin}` : "Whoever invited you";

  if (!invite || !invite.pending) {
    return (
      <SetupShell title="This invite has ended.">
        <p className="sign-in-body">It was used, revoked, or sent again with a new link. Ask whoever invited you for a fresh one.</p>
        <Foot signedIn={!!user} />
      </SetupShell>
    );
  }
  if (invite.expiresAt.getTime() <= Date.now()) {
    return (
      <SetupShell title="This invite expired.">
        <p className="sign-in-body">
          Invites to {invite.orgLogin} work for 7 days. {inviter} can send you a new one from Sandchest’s settings.
        </p>
        <Foot signedIn={!!user} />
      </SetupShell>
    );
  }
  if (!invite.installed) {
    return (
      <SetupShell title="Nothing to join.">
        <p className="sign-in-body">Sandchest isn’t installed on {invite.orgLogin} anymore, so there’s no team to join.</p>
        <Foot signedIn={!!user} />
      </SetupShell>
    );
  }

  const forWhom = invite.email !== null ? <>the GitHub account that has {maskEmail(invite.email)} verified</> : <strong>@{invite.githubLogin}</strong>;
  const wrongAccount = !!user && invite.githubUserId !== null && user.githubUserId !== null && user.githubUserId !== invite.githubUserId;
  return (
    <SetupShell title={`Join ${invite.orgLogin}.`}>
      <p className="invite-org">
        <Avatar src={`https://avatars.githubusercontent.com/${encodeURIComponent(invite.orgLogin)}`} />
        <span>
          {inviter} invited you to {invite.orgLogin}’s team on Sandchest.
        </span>
      </p>
      <p className="sign-in-body">
        You’ll see what Sandchest finds in every repository it watches on {invite.orgLogin}: real vulnerabilities, how they’re exploited and how to fix them. You can scan, review and resolve
        findings; the account’s settings and billing stay with its admins.
      </p>

      {!user ? (
        authConfigured() ? (
          <>
            <form action={signIn.bind(null, `/invite/${token}`)}>
              <button type="submit" className="key key-primary key-large key-glow" data-track="invite-sign-in">
                <span className="key-face">Continue with GitHub</span>
              </button>
            </form>
            <p className="sign-in-note">Sign in as {forWhom}. The invite only works for that person.</p>
          </>
        ) : (
          <p className="notice">Sign-in isn’t set up on this deployment yet.</p>
        )
      ) : wrongAccount ? (
        <>
          <p className="notice">
            This invite is for @{invite.githubLogin}, and you’re signed in as @{user.login ?? user.name}. Sign out, sign in to GitHub as @{invite.githubLogin}, then open this link again.
          </p>
          <form action={switchAccount.bind(null, token)}>
            <button type="submit" className="key key-secondary key-large" data-track="invite-switch-account">
              <span className="key-face">Sign out</span>
            </button>
          </form>
        </>
      ) : (
        <>
          <JoinTeamForm token={token} org={invite.orgLogin} email={invite.email !== null ? maskEmail(invite.email) : null} githubLogin={invite.githubLogin} you={user.login ?? user.name} />
          <form action={switchAccount.bind(null, token)} className="invite-switch">
            <p className="sign-in-note">
              Signed in as <strong>@{user.login ?? user.name}</strong>. Not the right account?{" "}
              <button type="submit" className="link-button" data-track="invite-switch-account">
                Sign out
              </button>
            </p>
          </form>
        </>
      )}
    </SetupShell>
  );
}

function Foot({ signedIn }: { signedIn: boolean }) {
  return (
    <p className="sign-in-note">
      {signedIn ? <a href="/dashboard">Go to your dashboard</a> : <a href="/">What is Sandchest?</a>}
    </p>
  );
}
