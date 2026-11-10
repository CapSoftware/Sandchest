import { autoTopUpSize, DEFAULT_CREDITS, DEFAULT_TOP_UP_LIMIT_USD, isTrial, PLAN, planById } from "@sandchest/billing/plans";
import type { OrgBillingRow, OrgSettings } from "@sandchest/db";
import { Link } from "@/components/app/hover-link";
import { creditCount, creditsText, plural, shortDate, usd } from "@/lib/format";
import { PRICE_NOTE, PRICES } from "@/lib/pricing";
import { openPortal } from "@/server/billing-actions";
import { AutoTopUpForm } from "./auto-top-up-form";
import { PlanPicker } from "./plan-picker";
import { Submit } from "./submit";
import { TopUpForm } from "./top-up-form";

/** One org's plan, credits and auto top-up. Admins change them; everyone else sees them. */
export function BillingPanel({ org, billing }: { org: { id: string; login: string; admin: boolean; settings: OrgSettings }; billing: OrgBillingRow | null }) {
  const plan = planById(billing?.planId);
  if (!billing || !plan) {
    return (
      <div>
        <p className="field-legend">Plan</p>
        <p className="field-help">
          {billing?.credits ? `${creditsText(billing.credits)} left, but no plan. ` : ""}
          Sandchest starts scanning {org.login}’s repositories once it joins the plan: {PRICES.plan} {PRICE_NOTE}
          {!org.admin && " Only an admin of this account can join."}
        </p>
        {org.admin && (
          <Link href={`/dashboard/recruit?org=${org.id}`} className="key key-primary">
            Recruit {org.login}’s hacker
          </Link>
        )}
      </div>
    );
  }

  // Free credits: nothing to charge, so no top-ups or auto top-up. Joining Standard keeps what's left.
  if (isTrial(plan.id)) {
    const out = billing.credits <= 0;
    return (
      <>
        <div>
          <p className="field-legend">Plan</p>
          <p className="plan-line">
            <span className="plan-line-name">{plan.name}</span> no card, nothing to pay
          </p>
        </div>
        <div>
          <p className="field-legend">Credits</p>
          <p className="credits">
            <span className="credits-left">{billing.credits.toLocaleString("en-US")}</span> free {billing.credits === 1 ? "credit" : "credits"} left
          </p>
          <p className={out ? "form-error" : "field-help"} role={out ? "alert" : undefined}>
            {out
              ? `The free credits are spent, so Sandchest has stopped scanning ${org.login}. Join ${PLAN.name} to keep going.`
              : `When they run out, Sandchest stops scanning until ${org.login} joins ${PLAN.name}. Credits left over carry across.`}
          </p>
        </div>
        <div>
          <p className="field-legend">Keep going</p>
          <p className="field-help">
            {PRICES.plan} {PRICE_NOTE}
            {!org.admin && " Only an admin of this account can join."}
          </p>
          <PlanPicker orgId={org.id} current={null} admin={org.admin} />
        </div>
      </>
    );
  }

  const choice = org.settings.autoTopUp;
  const autoOn = !!billing.autoTopUp?.enabled;
  const quantity = choice?.quantity ?? DEFAULT_CREDITS;
  const next = planById(billing.nextPlanId);
  const auto = autoOn ? billing.autoTopUp! : null;
  const autoSize = auto ? autoTopUpSize(plan, auto.quantity) : null;
  return (
    <>
      <div>
        <p className="field-legend">Plan</p>
        <p className="plan-line">
          <span className="plan-line-name">{plan.name}</span> {usd(plan.price)} a month
          {billing.endsAt ? ` · ends ${shortDate(billing.endsAt)}` : billing.renewsAt ? ` · renews ${shortDate(billing.renewsAt)}` : ""}
          {next && ` · ${next.name} from ${shortDate(billing.renewsAt ?? billing.creditsResetAt ?? new Date())}`}
        </p>
        {billing.pastDue && (
          <p className="form-error" role="alert">
            The last payment failed. Update the card to keep scanning.
          </p>
        )}
      </div>

      <div>
        <p className="field-legend">Credits</p>
        <p className="credits">
          <span className="credits-left">{billing.credits.toLocaleString("en-US")}</span> left
          {plan.credits > 0 && billing.creditsResetAt && <span className="field-help"> · {plan.name}’s monthly credits reset {shortDate(billing.creditsResetAt)}</span>}
        </p>
        <p className="field-help">
          {PRICES.credits} Bought credits never expire{plan.credits > 0 ? " and are spent after the month’s credits" : ""}. {PRICE_NOTE}
        </p>
        {org.admin && <TopUpForm orgId={org.id} />}
      </div>

      <div>
        <p className="field-legend">Auto top-up</p>
        <p className="field-help">
          {auto && autoSize
            ? `On: adds ${creditsText(autoSize.credits)} for ${usd(autoSize.price)} when your balance falls below ${creditCount(auto.threshold)}, ${auto.perMonth === null ? "with no monthly limit" : `up to ${plural(auto.perMonth, "time")} a month`}.`
            : "Off. Pull request reviews stop when credits run out."}
        </p>
        {org.admin && <AutoTopUpForm orgId={org.id} planId={plan.id} enabled={autoOn} quantity={quantity} limit={choice ? choice.monthlyLimitUsd : DEFAULT_TOP_UP_LIMIT_USD} />}
      </div>

      {!plan.offered && (
        <div>
          <p className="field-legend">Change plan</p>
          <p className="field-help">
            {plan.name} is no longer sold, and stays yours as long as you keep it. {PRICES.plan}
          </p>
          <PlanPicker orgId={org.id} current={plan.id} admin={org.admin} />
        </div>
      )}

      {org.admin && (
        <form action={openPortal.bind(null, org.id)}>
          <p className="field-legend">Card and invoices</p>
          <p className="field-help">Update the card, download invoices or cancel, on Stripe.</p>
          <Submit className="key key-secondary" pending="Opening…" track="billing-portal">
            Manage billing
          </Submit>
        </form>
      )}
    </>
  );
}
