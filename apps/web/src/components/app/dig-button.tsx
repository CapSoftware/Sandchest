"use client";
import { useActionState } from "react";
import { dig, type DigOutcome } from "@/server/dig-action";
import { Submit } from "./submit";

/** Starts a deep scan, then opens its live feed. */
export function DigButton({ repoId, note }: { repoId: string; note: string }) {
  const [state, action] = useActionState<DigOutcome>(() => dig(repoId), {});
  return (
    <form action={action} className="repo-dig">
      <Submit className="key key-primary" pending="Starting…">
        Dig
      </Submit>
      {state.error ? (
        <span className="repo-dig-error" role="alert">
          {state.error}
          {state.topUp && (
            <>
              {" "}
              <a href="/settings#billing">Billing</a>
            </>
          )}
        </span>
      ) : (
        <span className="repo-dig-note">{note}</span>
      )}
    </form>
  );
}
