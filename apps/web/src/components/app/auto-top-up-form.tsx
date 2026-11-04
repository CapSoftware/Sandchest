"use client";
import { autoTopUpSize, CREDIT_AMOUNTS, PLAN, planById, TOP_UP_BELOW } from "@sandchest/billing/plans";
import { useActionState } from "react";
import { usd } from "@/lib/format";
import { saveAutoTopUp, type BillingOutcome } from "@/server/billing-actions";
import { Submit } from "./submit";

/** Auto top-up: on or off, how many credits it buys, and the most it may spend in a month (empty: no limit). */
export function AutoTopUpForm({ orgId, planId, enabled, quantity, limit }: { orgId: string; planId: string; enabled: boolean; quantity: number; limit: number | null }) {
  // Priced only on the current plan: earlier plans round up to their packs, and the panel says what that buys.
  const plan = planById(planId) ?? PLAN;
  const [state, action] = useActionState<BillingOutcome, FormData>(saveAutoTopUp.bind(null, orgId), {});
  const amounts = CREDIT_AMOUNTS.includes(quantity as (typeof CREDIT_AMOUNTS)[number]) ? CREDIT_AMOUNTS : [...CREDIT_AMOUNTS, quantity].sort((a, b) => a - b);
  return (
    <form action={action} className="auto-top-up">
      <p className="inline-form">
        <label className="toggle">
          <input type="checkbox" name="enabled" defaultChecked={enabled} />
          Buy
        </label>
        <label className="sr-only" htmlFor={`quantity-${orgId}`}>
          Credits each time
        </label>
        <select id={`quantity-${orgId}`} name="quantity" className="select" defaultValue={String(quantity)}>
          {amounts.map((amount) => (
            <option key={amount} value={amount}>
              {amount} credits
              {plan.id === PLAN.id && `, ${usd(autoTopUpSize(plan, amount).price)}`}
            </option>
          ))}
        </select>
        <span className="field-help">when fewer than {TOP_UP_BELOW} are left</span>
      </p>
      <div className="inline-form">
        <label htmlFor={`limit-${orgId}`} className="field-help">
          Spend at most
        </label>
        <span className="money-input">
          <span aria-hidden="true">$</span>
          <input id={`limit-${orgId}`} name="limit" type="number" inputMode="numeric" min={1} step={10} defaultValue={limit ?? ""} placeholder="No limit" />
        </span>
        <span className="field-help">a month (empty for no limit)</span>
        <Submit className="key key-secondary" pending="Saving…" track="auto-top-up-save">
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
