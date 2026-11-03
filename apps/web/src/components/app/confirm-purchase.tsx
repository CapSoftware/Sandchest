"use client";
import { useActionState } from "react";
import { confirmPurchase, type BillingOutcome } from "@/server/billing-actions";
import { Submit } from "./submit";

/** The button that charges the card on file, once the admin has seen the amount. */
export function ConfirmPurchase({ orgId, fields, label }: { orgId: string; fields: Record<string, string>; label: string }) {
  const [state, action] = useActionState<BillingOutcome, FormData>(confirmPurchase.bind(null, orgId), {});
  return (
    <form action={action} className="form-foot">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Submit className="key key-primary" pending="Charging…" track="purchase-confirm">
        {label}
      </Submit>
      <a className="quiet" href="/dashboard/settings#billing">
        Cancel
      </a>
      {state.error && (
        <span className="form-error" role="alert">
          {state.error}
        </span>
      )}
    </form>
  );
}
