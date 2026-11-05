"use client";
import { useActionState, useEffect, useState } from "react";
import type { InviteOutcome } from "@/server/team";
import { invitePerson, leaveTeam, removeTeammate, resendInvite, revokeTeamInvite, type InviteState } from "@/server/team-actions";
import { Avatar } from "./avatar";
import { CopyText } from "./copy-text";
import { Submit } from "./submit";

/** One row of the team as Settings shows it; the page words `note` so it reads the same on server and client. */
export interface TeamRow {
  key: string;
  kind: "person" | "invite";
  /** A person's user id, or an invite's id. */
  id: string;
  image: string | null;
  name: string;
  /** "@login", or an invite's address. */
  handle: string | null;
  note: string;
  /** Removable (joined by invite) or, for invites, pending. */
  actionable: boolean;
  expired?: boolean;
}

/** An invite just sent: who it's for and, when it wasn't emailed, the link to send them. */
function Sent({ outcome }: { outcome: Extract<InviteOutcome, { ok: true }> }) {
  if (outcome.emailed) {
    return (
      <p className="team-status" role="status">
        Invite sent to {outcome.who}. It works for 7 days.
      </p>
    );
  }
  return (
    <div className="team-link" role="status">
      <p className="field-help">
        {outcome.who.startsWith("@") ? `Send ${outcome.who} this link.` : `Email isn’t set up here, so send ${outcome.who} this link.`} It works for 7 days, only for them, and
        won’t be shown again.
      </p>
      <code className="team-link-url">{outcome.link}</code>
      <CopyText text={outcome.link} label="Copy invite link" />
    </div>
  );
}

/** The invite form. */
function InviteForm({ orgId, org }: { orgId: string; org: string }) {
  const [state, action] = useActionState<InviteState, FormData>(invitePerson.bind(null, orgId), {});
  const outcome = state.outcome;
  return (
    <div className="team-invite">
      <form action={action} className="inline-form">
        <label className="text-field team-field">
          <span className="sr-only">Email or GitHub username</span>
          <input name="invitee" type="text" inputMode="email" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={254} placeholder="Email or GitHub username" required aria-label={`Invite someone to ${org}`} />
        </label>
        <Submit className="key key-primary" pending="Inviting…" track="team-invite">
          Invite
        </Submit>
      </form>
      {outcome &&
        (outcome.ok ? (
          <Sent outcome={outcome} />
        ) : (
          <p className="team-status" role="alert" data-error="">
            {outcome.error}
          </p>
        ))}
    </div>
  );
}

/**
 * A two-step button: the first press asks, the second submits. Asking lapses
 * after a few seconds. A real form, so the demo can stop it like any other.
 */
function Confirm({ label, confirm, track, action }: { label: string; confirm: string; track: string; action: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAsking(false), 4_000);
    return () => clearTimeout(timer);
  }, [asking]);
  return (
    <form action={action} className="team-form">
      {asking ? (
        <Submit className="quiet team-danger" pending="…" bare track={`${track}-confirm`}>
          {confirm}
        </Submit>
      ) : (
        <button type="button" className="quiet" data-track={track} onClick={() => setAsking(true)}>
          {label}
        </button>
      )}
    </form>
  );
}

function InviteActions({ row }: { row: TeamRow }) {
  const [sent, action] = useActionState<InviteOutcome | undefined, FormData>(() => resendInvite(row.id), undefined);
  return (
    <>
      <span className="team-actions">
        <form action={action} className="team-form">
          <Submit className="quiet" pending="Sending…" bare track="team-invite-resend">
            {row.handle?.startsWith("@") ? "New link" : "Send again"}
          </Submit>
        </form>
        <Confirm label="Revoke" confirm="Revoke it?" track="team-invite-revoke" action={() => revokeTeamInvite(row.id)} />
      </span>
      {sent && (
        <div className="team-row-after">
          {sent.ok ? (
            <Sent outcome={sent} />
          ) : (
            <p className="team-status" role="alert" data-error="">
              {sent.error}
            </p>
          )}
        </div>
      )}
    </>
  );
}

/**
 * An org's team for its admins: everyone with access, how they got it, and
 * pending invites; invite more, send again, revoke, remove.
 */
export function TeamPanel({ orgId, org, rows }: { orgId: string; org: string; rows: TeamRow[] }) {
  return (
    <div className="team">
      <p className="field-legend">Team</p>
      <p className="field-help">
        Anyone who can push to a repository on GitHub sees it here once they sign in. Invite anyone else: they’ll see every repository Sandchest watches on {org}, and can
        scan, review and resolve findings. Settings and billing stay with admins.
      </p>
      <InviteForm orgId={orgId} org={org} />
      {rows.length > 0 && (
        <ul className="team-list" aria-label={`${org}’s team`}>
          {rows.map((row) => (
            <li key={row.key} className={row.expired ? "team-row team-row-expired" : "team-row"}>
              <Avatar src={row.image} />
              <span className="team-who">
                <span className="team-name">{row.name}</span>
                {row.handle && row.handle !== row.name && <span className="team-handle">{row.handle}</span>}
              </span>
              <span className="team-note">{row.note}</span>
              {row.kind === "invite" ? (
                <InviteActions row={row} />
              ) : row.actionable ? (
                <span className="team-actions">
                  <Confirm label="Remove" confirm={`Remove ${row.handle ?? row.name}?`} track="team-member-remove" action={() => removeTeammate(orgId, row.id)} />
                </span>
              ) : (
                <span className="team-actions" />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** For someone who joined by invite: leave. */
export function LeaveTeam({ orgId, org }: { orgId: string; org: string }) {
  return (
    <div className="team">
      <p className="field-legend">Team</p>
      <p className="field-help">You joined {org} by invite, so you see all its repositories here. Leaving takes away what the invite gave you; anything GitHub lets you push to stays.</p>
      <Confirm label={`Leave ${org}`} confirm={`Leave ${org}? Press again`} track="team-leave" action={() => leaveTeam(orgId)} />
    </div>
  );
}
