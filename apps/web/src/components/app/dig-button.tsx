"use client";
import { useActionState, useState } from "react";
import { dig, type DigOutcome } from "@/server/dig-action";
import { Submit } from "./submit";

/**
 * Starts a deep scan, then opens its live feed. When it costs credits, the
 * first press only asks: the second, on a key that names the price, starts it.
 */
export function DigButton({ repoId, label, note, confirm }: { repoId: string; label: string; note: string; confirm?: string }) {
  const [state, action] = useActionState<DigOutcome>(() => dig(repoId), {});
  const [asking, setAsking] = useState(false);
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
          {state.topUp && (
            <>
              {" "}
              <a href="/dashboard/settings/billing">Billing</a>
            </>
          )}
        </span>
      ) : (
        <span className="repo-dig-note">{note}</span>
      )}
    </form>
  );
}
