/** Back from Stripe, while the payment is confirmed. Nothing to draw a skeleton of: this page only redirects. */
export default function Loading() {
  return (
    <div aria-busy="true">
      <h1 className="page-title">Billing</h1>
      <p className="page-sub" role="status">
        Confirming your payment…
      </p>
    </div>
  );
}
