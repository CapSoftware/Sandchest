import { PageSkeleton } from "@/components/app/skeleton";

/** Shown while billing prices the change, which can take a moment. */
export default function Loading() {
  return (
    <PageSkeleton id="confirm" label="Pricing the change">
      <div className="confirm">
        <h1 className="page-title">Switch acme to Team</h1>
        <dl className="stats confirm-stats">
          <div className="stat">
            <dt>Charged now</dt>
            <dd>$49.00</dd>
          </div>
        </dl>
        <p className="field-help">Team starts now with 400 credits a month. You pay the difference for the rest of this period.</p>
        <span className="key key-primary">
          <span className="key-face">Pay $49.00</span>
        </span>
      </div>
    </PageSkeleton>
  );
}
