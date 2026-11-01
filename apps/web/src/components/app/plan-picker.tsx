"use client";
import { PLANS } from "@sandchest/billing/plans";
import { useActionState } from "react";
import { purchase, type BillingOutcome } from "@/server/billing-actions";
import { Submit } from "./submit";

/** The three plans. Choosing one opens Stripe Checkout, or a confirm page when the org already pays. */
export function PlanPicker({ orgId, current, admin }: { orgId: string; current: string | null; admin: boolean }) {
  const [state, action] = useActionState<BillingOutcome, FormData>(purchase.bind(null, orgId), {});
  return (
    <form action={action} className="plans">
      <input type="hidden" name="kind" value="plan" />
      <ul className="plan-list">
        {PLANS.map((plan) => (
          <li key={plan.id} className="plan" data-current={current === plan.id || undefined}>
            <h3 className="plan-name">{plan.name}</h3>
            <p className="plan-price">
              <span>${plan.price}</span> a month
            </p>
            <p className="plan-credits">{plan.credits.toLocaleString("en-US")} credits a month</p>
            <p className="plan-fit">
              About {Math.floor(plan.credits / 15)} deep scans, or {plan.credits.toLocaleString("en-US")} small reviews
            </p>
            {current === plan.id ? (
              <span className="plan-current">Your plan</span>
            ) : admin ? (
              <Submit className={current ? "key key-secondary" : "key key-primary"} name="plan" value={plan.id} pending="Opening…">
                {current ? `Switch to ${plan.name}` : `Choose ${plan.name}`}
              </Submit>
            ) : null}
          </li>
        ))}
      </ul>
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
    </form>
  );
}
