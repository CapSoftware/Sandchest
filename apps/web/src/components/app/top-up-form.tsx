"use client";
import { MAX_TOP_UP_PACKS, TOP_UP } from "@sandchest/billing/plans";
import { useActionState } from "react";
import { purchase, type BillingOutcome } from "@/server/billing-actions";
import { Submit } from "./submit";

const PACKS = [1, 2, 4, 10, MAX_TOP_UP_PACKS];

/** Buys top-up packs. The charge is shown on a confirm page first. */
export function TopUpForm({ orgId }: { orgId: string }) {
  const [state, action] = useActionState<BillingOutcome, FormData>(purchase.bind(null, orgId), {});
  return (
    <form action={action} className="inline-form">
      <input type="hidden" name="kind" value="top_up" />
      <label className="sr-only" htmlFor={`packs-${orgId}`}>
        Credits to buy
      </label>
      <select id={`packs-${orgId}`} name="packs" className="select" defaultValue="1">
        {PACKS.map((packs) => (
          <option key={packs} value={packs}>
            {packs * TOP_UP.credits} credits · ${packs * TOP_UP.price}
          </option>
        ))}
      </select>
      <Submit className="key key-secondary" pending="Opening…">
        Top up
      </Submit>
      {state.error && (
        <span className="form-error" role="alert">
          {state.error}
        </span>
      )}
    </form>
  );
}
