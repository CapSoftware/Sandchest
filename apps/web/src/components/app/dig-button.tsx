"use client";
import { startTransition, useActionState, useRef, useState } from "react";
import { dig, type DigOutcome } from "@/server/dig-action";
import { AddCredits, type CreditsAccount } from "./add-credits";
import { Submit } from "./submit";

/**
 * Starts a deep scan, then goes to the hacker at work on it. When it is paid
 * for, the first press only asks: the second, on a key beside what it costs,
 * starts it. Short of balance (`short`, or refused for it), the key opens the
 * dialog to add funds, which starts the scan once they're in. `fast`: the account is offered a fast scan, chosen with a
 * switch on the confirming key, unticked each time it opens.
 */
export function DigButton({
  repoId,
  label,
  note,
  confirm,
  account,
  need,
  short = false,
  fast,
}: {
  repoId: string;
  label: string;
  note: string;
  confirm?: string;
  /** The account that pays, when billing is on. */
  account?: CreditsAccount;
  /** Credits the scan holds: the most it can be charged. */
  need?: number;
  short?: boolean;
  /** A fast scan, where the account is offered one: its confirming key, the credits it holds, and its note. */
  fast?: { confirm: string; need: number; note: string };
}) {
  const [fastOn, setFastOn] = useState(false);
  // Read when the action runs, also when it runs again after funds were added.
  const fastChosen = useRef(false);
  const chooseFast = (on: boolean) => {
    fastChosen.current = on;
    setFastOn(on);
  };
  const [state, action] = useActionState<DigOutcome>(() => (fastChosen.current ? dig(repoId, { fast: true }) : dig(repoId)), {});
  const [asking, setAsking] = useState(false);
  const [topping, setTopping] = useState(false);
  const toppable = account !== undefined && (short || state.topUp === true);
  const topUp = account && (
    <AddCredits account={account} need={fast && fastOn ? fast.need : need} open={topping} onClose={() => setTopping(false)} then={{ label: "start the scan", run: () => startTransition(() => action()) }} />
  );
  if (short && account) {
    return (
      <div className="repo-dig">
        <button type="button" className="key key-primary" onClick={() => setTopping(true)} data-track="deep-scan-top-up">
          <span className="key-face">{label}</span>
        </button>
        <span className="repo-dig-note">{note}</span>
        {topUp}
      </div>
    );
  }
  return (
    <form action={action} className="repo-dig">
      {confirm && !asking ? (
        <button type="button" className="key key-primary" onClick={() => setAsking(true)} data-track="deep-scan-open">
          <span className="key-face">{label}</span>
        </button>
      ) : (
        <span className="dig-confirm">
          {confirm && (
            <button
              type="button"
              className="dig-cancel"
              onClick={() => {
                setAsking(false);
                chooseFast(false);
              }}
              data-track="deep-scan-cancel"
            >
              Cancel
            </button>
          )}
          <Submit className="key key-primary" pending="Starting…" track="deep-scan-confirm">
            {fast && fastOn ? fast.confirm : (confirm ?? label)}
          </Submit>
        </span>
      )}
      {fast && confirm && asking && (
        <label className="toggle dig-fast">
          <input type="checkbox" checked={fastOn} onChange={(event) => chooseFast(event.target.checked)} data-track="deep-scan-fast" />
          <span className="dig-fast-text">
            <span className="dig-fast-name">Fast</span>
            <span className="dig-fast-help">Uses a faster model. Costs about 3x on average.</span>
          </span>
        </label>
      )}
      {state.error ? (
        <span className="repo-dig-error" role="alert">
          {state.error}
          {state.topUp &&
            (toppable ? (
              <>
                {" "}
                <button type="button" className="dig-cancel" onClick={() => setTopping(true)}>
                  Add funds
                </button>
              </>
            ) : (
              <>
                {" "}
                <a href="/dashboard/settings/billing">Billing</a>
              </>
            ))}
        </span>
      ) : (
        <span className="repo-dig-note">{fast && fastOn ? fast.note : note}</span>
      )}
      {topUp}
    </form>
  );
}
