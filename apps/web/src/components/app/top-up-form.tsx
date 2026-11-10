"use client";
import { creditsSaving, TOP_UP_AMOUNTS } from "@sandchest/billing/plans";
import { useActionState } from "react";
import { usd } from "@/lib/format";
import { fundsFor } from "@/lib/pricing";
import { purchase, type BillingOutcome } from "@/server/billing-actions";
import { Submit } from "./submit";

const AMOUNTS = TOP_UP_AMOUNTS;

/** Adds funds to the balance. The charge is shown on a confirm page first. */
export function TopUpForm({ orgId }: { orgId: string }) {
  const [state, action] = useActionState<BillingOutcome, FormData>(purchase.bind(null, orgId), {});
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="kind" value="top_up" />
      <label className="sr-only" htmlFor={`credits-${orgId}`}>
        Funds to add
      </label>
      <select id={`credits-${orgId}`} name="credits" className="select" defaultValue={String(AMOUNTS[0])}>
        {AMOUNTS.map((amount) => (
          <option key={amount} value={amount}>
            {fundsFor(amount)}
            {creditsSaving(amount) > 0 && ` (save ${usd(creditsSaving(amount))})`}
          </option>
        ))}
      </select>
      <Submit className="key key-secondary" pending="Opening…" track="top-up">
        Add funds
      </Submit>
      {state.error && (
        <span className="form-error" role="alert">
          {state.error}
        </span>
      )}
    </form>
  );
}
