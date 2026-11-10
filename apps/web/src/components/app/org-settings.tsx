"use client";
import { useActionState } from "react";
import { saveOrgSettings, type SettingsOutcome } from "@/server/actions";
import { Submit } from "./submit";

const THRESHOLDS = [
  { id: "critical", label: "Critical" },
  { id: "high", label: "High" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Any" },
] as const;

export function OrgSettingsForm({ orgId, threshold, email, admin }: { orgId: string; threshold: string; email: boolean; admin: boolean }) {
  const [state, action] = useActionState<SettingsOutcome, FormData>(saveOrgSettings.bind(null, orgId), {});
  return (
    <form action={action} className="settings-form">
      <fieldset disabled={!admin}>
        <legend className="field-legend">Fail pull request checks</legend>
        <p className="field-help">On open findings at or above this severity. Use branch protection to make it block merging.</p>
        <div className="segments">
          {THRESHOLDS.map((option) => (
            <label key={option.id} className="segment">
              <input type="radio" name="checkThreshold" value={option.id} defaultChecked={threshold === option.id} />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={!admin}>
        <legend className="field-legend">Email</legend>
        <p className="field-help">
          Findings go to people who can push to the repository and have signed in within 30 days; paused scans go to admins who have.
          Billing emails, such as a low balance or a failed top-up, go to admins too and can’t be turned off. If no admin has signed in
          lately, Sandchest asks GitHub which earlier ones still are.
        </p>
        <label className="toggle">
          <input type="checkbox" name="emailNotifications" defaultChecked={email} />
          Critical findings, finished deep scans and paused scans
        </label>
      </fieldset>
      {admin && (
        <div className="form-foot">
          <Submit className="key key-primary" pending="Saving…" track="settings-save">
            Save
          </Submit>
          {state.saved && <span role="status">Saved.</span>}
          {state.error && (
            <span role="alert" data-error="">
              {state.error}
            </span>
          )}
        </div>
      )}
    </form>
  );
}
