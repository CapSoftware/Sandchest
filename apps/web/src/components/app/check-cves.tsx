"use client";
import { useActionState } from "react";
import { checkForCves, type CheckOutcome } from "@/server/cve-actions";
import { Submit } from "./submit";

/** Reads one repository for the CVE directory, then says it's being read. */
export function CheckCves({ repoId }: { repoId: string }) {
  const [state, action] = useActionState<CheckOutcome>(() => checkForCves(repoId), {});
  if (state.queued) return <span className="cve-check-state"><span className="blink" aria-hidden="true" /> Reading now</span>;
  return (
    <form action={action} className="cve-check">
      <Submit className="key key-secondary" pending="Starting…" track="cve-check">
        Check for CVEs
      </Submit>
      {state.error && <span className="cve-check-error" role="alert">{state.error}</span>}
    </form>
  );
}
