"use client";
import type { PrReviewMode } from "@sandchest/db";
import { useActionState, useState } from "react";
import { plural } from "@/lib/format";
import { saveOrgReviews, type OrgReviewsOutcome } from "@/server/actions";
import { Submit } from "./submit";

const MODES: Array<{ id: PrReviewMode; label: string }> = [
  { id: "auto", label: "Every push" },
  { id: "command", label: "When asked" },
  { id: "off", label: "Off" },
];

/**
 * How an account's repositories review pull requests: the mode new
 * repositories start with and, if asked, every repository already here.
 * Each repository can still change its own on its page.
 */
export function OrgReviewsForm({ orgId, mode, admin }: { orgId: string; mode: PrReviewMode; admin: boolean }) {
  const [state, action] = useActionState<OrgReviewsOutcome, FormData>(saveOrgReviews.bind(null, orgId), {});
  const [chosen, setChosen] = useState(mode);
  return (
    <form action={action} className="settings-form">
      <fieldset disabled={!admin}>
        <legend className="field-legend">Pull request reviews</legend>
        <p className="field-help">
          {chosen === "auto"
            ? "Every push to a pull request is reviewed, for 1 to 3 credits by the size of the change."
            : chosen === "command"
              ? "Only when someone with write access comments /sandchest review, or presses Review on the repository’s page."
              : "Pull requests aren’t reviewed, and /sandchest review is ignored."}{" "}
          For repositories added from now on; each repository can change its own on its page.
        </p>
        <div className="segments">
          {MODES.map((option) => (
            <label key={option.id} className="segment">
              <input type="radio" name="prReviews" value={option.id} defaultChecked={mode === option.id} onChange={() => setChosen(option.id)} />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {admin && (
        <>
          <label className="toggle">
            <input type="checkbox" name="applyToAll" />
            Set every repository already here to this too
          </label>
          <div className="form-foot">
            <Submit className="key key-primary" pending="Saving…" track="settings-pr-reviews-save">
              Save
            </Submit>
            {state.saved && <span role="status">Saved.{state.changed ? ` ${plural(state.changed, "repository", "repositories")} changed.` : ""}</span>}
            {state.error && (
              <span role="alert" data-error="">
                {state.error}
              </span>
            )}
          </div>
        </>
      )}
    </form>
  );
}
