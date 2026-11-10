"use client";
import { useActionState, useState } from "react";
import { creditsText } from "@/lib/format";
import { quoteReview, startReview, type ReviewOutcome } from "@/server/pr-review-action";
import { Submit } from "./submit";

/**
 * Reviews a pull request's latest commit. With billing on, the first press
 * asks GitHub what changed and names the price; the second, on a key that
 * says it, starts the review and opens its live feed. A form, so the demo
 * stops it like every other action.
 */
export function PrReviewButton({ repoId, prNumber, again, priced }: { repoId: string; prNumber: number; again: boolean; priced: boolean }) {
  const [state, action] = useActionState<ReviewOutcome, FormData>(async (_previous, form) => {
    if (form.get("step") === "quote") return quoteReview(repoId, prNumber);
    return startReview(repoId, prNumber, Number(form.get("credits") ?? 0));
  }, {});
  const [cancelled, setCancelled] = useState(false);
  // Priced (or priced again, because the PR moved on): the next press confirms that price.
  const confirming = priced && state.credits !== undefined && !cancelled;

  return (
    <form action={action} className="pull-review" onSubmit={() => setCancelled(false)}>
      {confirming ? (
        <span className="dig-confirm">
          <button type="button" className="dig-cancel" onClick={() => setCancelled(true)} data-track="pr-review-cancel">
            Cancel
          </button>
          <input type="hidden" name="credits" value={state.credits} />
          <Submit className="key key-primary" name="step" value="start" pending="Starting…" track="pr-review-confirm">
            {state.credits === 0 ? "Review for free" : `Review for ${state.upTo ? "up to " : ""}${creditsText(state.credits!)}`}
          </Submit>
        </span>
      ) : (
        <Submit className="key key-secondary" name="step" value={priced ? "quote" : "start"} pending={priced ? "Pricing…" : "Starting…"} track={priced ? "pr-review-open" : "pr-review-confirm"}>
          {again ? "Review again" : "Review"}
        </Submit>
      )}
      {state.error && !cancelled && (
        <span className="pull-review-error" role="alert">
          {state.error}
          {state.topUp && (
            <>
              {" "}
              <a href="/dashboard/settings/billing">Billing</a>
            </>
          )}
          {state.scanId && !state.topUp && (
            <>
              {" "}
              <a href={`/dashboard/scans/${state.scanId}`}>See the review</a>
            </>
          )}
        </span>
      )}
    </form>
  );
}
