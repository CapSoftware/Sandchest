import { autoTopUpPrice, defaultAutoTopUpLimit, planById, TOP_UP } from "@sandchest/billing/plans";
import type { OrgBillingRow, OrgSettings } from "@sandchest/db";
import { plural, shortDate, usd } from "@/lib/format";
import { openPortal } from "@/server/billing-actions";
import { AutoTopUpForm } from "./auto-top-up-form";
import { PlanPicker } from "./plan-picker";
import { Submit } from "./submit";
import { TopUpForm } from "./top-up-form";

/** One org's plan, credits, top-ups and auto top-up. Admins change them; everyone else sees them. */
export function BillingPanel({ org, billing }: { org: { id: string; login: string; admin: boolean; settings: OrgSettings }; billing: OrgBillingRow | null }) {
  const plan = planById(billing?.planId);
  if (!billing || !plan) {
    return (
      <div>
        <p className="field-legend">Plan</p>
        <p className="field-help">
          {billing?.credits ? `${plural(billing.credits, "top-up credit")} left, but no plan. ` : ""}
          Sandchest starts digging into {org.login}’s repositories once it has a plan. Credits pay for pull request
          reviews (1–5 each) and deep scans (15–75); recon and fix checks are free.
          {!org.admin && " Only an admin of this account can choose one."}
        </p>
        <PlanPicker orgId={org.id} current={null} admin={org.admin} />
      </div>
    );
  }

  const share = Math.min(1, billing.credits / plan.credits);
  const choice = org.settings.autoTopUp;
  const autoOn = !!billing.autoTopUp?.enabled;
  const next = planById(billing.nextPlanId);
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
          {billing.creditsResetAt && <span className="field-help"> · plan credits reset {shortDate(billing.creditsResetAt)}</span>}
        </p>
        <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={plan.credits} aria-valuenow={Math.min(billing.credits, plan.credits)} aria-label="Credits left this month">
          <span style={{ width: `${share * 100}%` }} />
        </div>
        <p className="field-help">
          Reviews cost 1–5 credits by size; deep scans 15–75. Top-ups are {TOP_UP.credits} credits for {usd(TOP_UP.price)}, never expire,
          and are spent after the month’s credits.
        </p>
        {org.admin && <TopUpForm orgId={org.id} />}
      </div>

      <div>
        <p className="field-legend">Auto top-up</p>
        <p className="field-help">
          {autoOn
            ? `On: below ${billing.autoTopUp!.threshold} credits, buys ${billing.autoTopUp!.quantity}, up to ${plural(billing.autoTopUp!.perMonth, "time")} a month.`
            : "Off. Pull request reviews stop when credits run out."}
        </p>
        {org.admin && (
          <AutoTopUpForm
            orgId={org.id}
            enabled={autoOn}
            limit={choice?.monthlyLimitUsd ?? defaultAutoTopUpLimit(plan)}
            rule={`Buy ${plan.autoTopUp.packs * TOP_UP.credits} credits for ${usd(autoTopUpPrice(plan))} when fewer than ${plan.autoTopUp.below} are left`}
          />
        )}
      </div>

      <div>
        <p className="field-legend">Change plan</p>
        <PlanPicker orgId={org.id} current={plan.id} admin={org.admin} />
      </div>

      {org.admin && (
        <form action={openPortal.bind(null, org.id)}>
          <p className="field-legend">Card and invoices</p>
          <p className="field-help">Update the card, download invoices or cancel, on Stripe.</p>
          <Submit className="key key-secondary" pending="Opening…">
            Manage billing
          </Submit>
        </form>
      )}
    </>
  );
}
