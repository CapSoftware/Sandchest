import { MAX_TOP_UP_PACKS, planById, TOP_UP } from "@sandchest/billing/plans";
import { orgForAdmin } from "@sandchest/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ConfirmPurchase } from "@/components/app/confirm-purchase";
import { shortDate, usd } from "@/lib/format";
import { viewer } from "@/server/access";
import { autumn } from "@/server/billing";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Confirm · Sandchest" };

/** Shows exactly what a plan change or top-up will charge the card on file, before charging it. */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ org?: string; plan?: string; topup?: string }> }) {
  const params = await searchParams;
  const user = await viewer();
  const client = autumn();
  const row = client && params.org && /^[0-9a-f-]{36}$/.test(params.org) ? await orgForAdmin(db(), user.id, params.org) : undefined;
  if (!client || !row) redirect("/settings");

  const plan = planById(params.plan);
  const packs = Number(params.topup);
  const topUp = !plan && Number.isInteger(packs) && packs >= 1 && packs <= MAX_TOP_UP_PACKS;
  const current = planById(row.billing?.planId);
  if ((!plan && !topUp) || !current || plan?.id === current.id) redirect("/settings#billing");

  const preview = await client.preview({ customerId: row.org.id, planId: plan ? plan.id : TOP_UP.id, packs: topUp ? packs : undefined }).catch(() => undefined);
  const downgrade = plan && plan.price < current.price;
  const title = plan ? `Switch ${row.org.githubLogin} to ${plan.name}` : `Buy ${packs * TOP_UP.credits} credits for ${row.org.githubLogin}`;
  const fields: Record<string, string> = plan ? { kind: "plan", plan: plan.id } : { kind: "top_up", packs: String(packs) };

  return (
    <div className="confirm">
      <h1 className="page-title">{title}</h1>
      {preview ? (
        <dl className="stats confirm-stats">
          <div className="stat">
            <dt>Charged now</dt>
            <dd>{usd(preview.dueToday)}</dd>
          </div>
          {plan && preview.nextCycle !== null && (
            <div className="stat">
              <dt>Then{preview.nextCycleAt ? ` from ${shortDate(preview.nextCycleAt)}` : ""}</dt>
              <dd>{usd(preview.nextCycle)} a month</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="form-error" role="alert">
          Billing couldn’t price this right now. Try again in a minute.
        </p>
      )}
      <p className="field-help">
        {plan
          ? downgrade
            ? `${current.name} stays until the end of this period, then ${plan.name} starts with ${plan.credits.toLocaleString("en-US")} credits a month.`
            : `${plan.name} starts now with ${plan.credits.toLocaleString("en-US")} credits a month. You pay the difference for the rest of this period.`
          : "Charged to the card on file. Top-up credits never expire and are spent after the month’s credits."}
      </p>
      {preview && <ConfirmPurchase orgId={row.org.id} fields={fields} label={preview.dueToday > 0 ? `Pay ${usd(preview.dueToday)}` : "Confirm"} />}
    </div>
  );
}
