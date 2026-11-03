import { ConfirmPurchase } from "@/components/app/confirm-purchase";
import { shortDate, usd } from "@/lib/format";

/** What billing quoted: due now, and for a plan, the monthly charge after. */
export type Quote = { dueToday: number; nextCycle: number | null; nextCycleAt?: Date | null };

/** The confirm step, drawn from billing's quote; its loading state draws it from a sample one. Without a quote, billing couldn't price it. */
export function ConfirmView({ orgId, title, preview, help, fields }: { orgId: string; title: string; preview: Quote | undefined; help: string; fields: Record<string, string> }) {
  return (
    <div className="confirm">
      <h1 className="page-title">{title}</h1>
      {preview ? (
        <dl className="stats confirm-stats">
          <div className="stat">
            <dt>Charged now</dt>
            <dd>{usd(preview.dueToday)}</dd>
          </div>
          {preview.nextCycle !== null && (
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
      <p className="field-help">{help}</p>
      {preview && <ConfirmPurchase orgId={orgId} fields={fields} label={preview.dueToday > 0 ? `Pay ${usd(preview.dueToday)}` : "Confirm"} />}
    </div>
  );
}
