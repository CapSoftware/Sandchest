"use client";
import { useActionState } from "react";
import { acceptTeamInvite, type JoinState } from "@/server/team-actions";
import { Submit } from "./submit";

/** "Join" on an invite's page, and why it didn't work when it doesn't. */
export function JoinTeamForm({ token, org, email, githubLogin, you }: { token: string; org: string; email: string | null; githubLogin: string | null; you: string }) {
  const [state, action] = useActionState<JoinState, FormData>(acceptTeamInvite.bind(null, token), {});
  const outcome = state.outcome;
  return (
    <form action={action}>
      <Submit className="key key-primary key-large key-glow" pending="Joining…" track="invite-join">
        Join {org}
      </Submit>
      {outcome && !outcome.ok && (
        <p className="notice" role="alert">
          {outcome.reason === "wrong_person"
            ? email !== null
              ? <>GitHub doesn’t list {email} as a verified email on @{you}. Add and verify it in your <a href="https://github.com/settings/emails">GitHub email settings</a>, then press Join again. Or sign in with the account that has it.</>
              : <>This invite is for @{githubLogin}, not @{you}. Sign in as @{githubLogin} to join.</>
            : outcome.reason === "expired"
              ? "This invite expired. Ask for a new one."
              : outcome.reason === "inviter_gone"
                ? "Whoever sent this invite isn’t an admin of this account anymore, so it no longer works. Ask a current admin for a new one."
                : outcome.reason === "no_installation"
                ? `Sandchest isn’t installed on ${org} anymore.`
                : outcome.reason === "github_error"
                  ? "GitHub didn’t answer. Try again in a moment."
                  : outcome.reason === "limited"
                    ? "Too many tries. Wait a minute, then try again."
                    : "This invite has ended. Ask for a new one."}
        </p>
      )}
    </form>
  );
}
