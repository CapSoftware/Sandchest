"use client";
import { startTransition, useActionState, useState } from "react";
import { dig, type DigOutcome } from "@/server/dig-action";
import { AddCredits, type CreditsAccount } from "./add-credits";
import { Submit } from "./submit";

/**
 * Starts a deep scan, then opens its live feed. When it costs credits, the
 * first press only asks: the second, on a key that names the price, starts it.
 * Short of credits (`short`, or refused for them), the key opens the dialog to
 * add them, which starts the scan once they're in.
 */
export function DigButton({
  repoId,
  label,
  note,
  confirm,
  account,
  need,
  short = false,
}: {
  repoId: string;
  label: string;
  note: string;
  confirm?: string;
  /** The account that pays, when billing is on. */
  account?: CreditsAccount;
  /** Credits the scan holds. */
  need?: number;
  short?: boolean;
}) {
  const [state, action] = useActionState<DigOutcome>(() => dig(repoId), {});
  const [asking, setAsking] = useState(false);
  const [topping, setTopping] = useState(false);
  const toppable = account !== undefined && (short || state.topUp === true);
  const topUp = account && (
    <AddCredits account={account} need={need} open={topping} onClose={() => setTopping(false)} then={{ label: "start the scan", run: () => startTransition(() => action()) }} />
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
            <button type="button" className="dig-cancel" onClick={() => setAsking(false)} data-track="deep-scan-cancel">
              Cancel
            </button>
          )}
          <Submit className="key key-primary" pending="Starting…" track="deep-scan-confirm">
            {confirm ?? label}
          </Submit>
        </span>
      )}
      {state.error ? (
        <span className="repo-dig-error" role="alert">
          {state.error}
          {state.topUp &&
            (toppable ? (
              <>
                {" "}
                <button type="button" className="dig-cancel" onClick={() => setTopping(true)}>
                  Add credits
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
        <span className="repo-dig-note">{note}</span>
      )}
      {topUp}
    </form>
  );
}
