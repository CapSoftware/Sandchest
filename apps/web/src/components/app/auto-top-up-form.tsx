"use client";
import { useActionState } from "react";
import { saveAutoTopUp, type BillingOutcome } from "@/server/billing-actions";
import { Submit } from "./submit";

/** Auto top-up: on or off, and the most it may spend in a month. */
export function AutoTopUpForm({ orgId, enabled, limit, rule }: { orgId: string; enabled: boolean; limit: number; rule: string }) {
  const [state, action] = useActionState<BillingOutcome, FormData>(saveAutoTopUp.bind(null, orgId), {});
  return (
    <form action={action} className="auto-top-up">
      <label className="toggle">
        <input type="checkbox" name="enabled" defaultChecked={enabled} />
        {rule}
      </label>
      <div className="inline-form">
        <label htmlFor={`limit-${orgId}`} className="field-help">
          Spend at most
        </label>
        <span className="money-input">
          <span aria-hidden="true">$</span>
          <input id={`limit-${orgId}`} name="limit" type="number" inputMode="numeric" min={10} step={10} defaultValue={limit} />
        </span>
        <span className="field-help">a month</span>
        <Submit className="key key-secondary" pending="Saving…">
          Save
        </Submit>
        {state.saved && <span role="status">Saved.</span>}
        {state.error && (
          <span className="form-error" role="alert">
            {state.error}
          </span>
        )}
      </div>
    </form>
  );
}
