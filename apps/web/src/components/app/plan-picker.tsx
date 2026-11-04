"use client";
import { CREDIT_AMOUNTS, creditsPrice, creditsSaving, DEFAULT_CREDITS, DEFAULT_TOP_UP_LIMIT_USD, PLAN, TOP_UP_BELOW } from "@sandchest/billing/plans";
import { useActionState, useState } from "react";
import { usd } from "@/lib/format";
import { PRICES } from "@/lib/pricing";
import { purchase, type BillingOutcome } from "@/server/billing-actions";
import { Submit } from "./submit";

/**
 * Joining the plan, with the credits to start on; or, for an org on a plan
 * that is no longer sold, switching to it (credits already bought stay).
 * Opens Stripe Checkout, or a confirm page when the org already pays.
 */
export function PlanPicker({ orgId, current, admin }: { orgId: string; current: string | null; admin: boolean }) {
  const [state, action] = useActionState<BillingOutcome, FormData>(purchase.bind(null, orgId), {});
  const [credits, setCredits] = useState<number>(DEFAULT_CREDITS);
  // Joining turns auto top-up on, as recruiting does, unless they untick it.
  const [autoTopUp, setAutoTopUp] = useState(true);
  const switching = current !== null;
  return (
    <form action={action} className="plans">
      <input type="hidden" name="kind" value="plan" />
      <input type="hidden" name="plan" value={PLAN.id} />
      <div className="plan">
        <h3 className="plan-name">{PLAN.name}</h3>
        <p className="plan-price">
          <span>{usd(PLAN.price)}</span> a month
        </p>
        <p className="plan-fit">
          {PRICES.plan} {PRICES.review}
        </p>
        {admin && !switching && (
          <p className="inline-form">
            <label htmlFor={`start-${orgId}`} className="field-help">
              Start with
            </label>
            <select id={`start-${orgId}`} name="credits" className="select" value={credits} onChange={(event) => setCredits(Number(event.target.value))}>
              {CREDIT_AMOUNTS.map((amount) => (
                <option key={amount} value={amount}>
                  {amount} credits, {usd(creditsPrice(amount))}
                  {creditsSaving(amount) > 0 && ` (save ${usd(creditsSaving(amount))})`}
                </option>
              ))}
            </select>
          </p>
        )}
        {admin && !switching && (
          <p className="field-help">
            <input type="hidden" name="autoTopUp" value={autoTopUp ? "on" : "off"} />
            <label className="toggle">
              <input type="checkbox" checked={autoTopUp} onChange={(event) => setAutoTopUp(event.target.checked)} data-track={autoTopUp ? "plan-auto-top-up-off" : "plan-auto-top-up-on"} />
              Auto top-up
            </label>{" "}
            {autoTopUp
              ? `adds ${credits} credits for ${usd(creditsPrice(credits))} whenever fewer than ${TOP_UP_BELOW} are left, up to ${usd(DEFAULT_TOP_UP_LIMIT_USD)} a month. Once joined, you can change the limit here.`
              : "is off, so pull request reviews stop when the credits run out."}
          </p>
        )}
        {admin && (
          <Submit className={switching ? "key key-secondary" : "key key-primary"} pending="Opening…" track={switching ? "plan-change" : "plan-choose"}>
            {switching ? `Switch to ${PLAN.name}` : `Join for ${usd(PLAN.price + creditsPrice(credits))}`}
          </Submit>
        )}
      </div>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
