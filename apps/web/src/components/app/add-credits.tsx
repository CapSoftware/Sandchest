"use client";
import { creditsPrice, creditsSaving, PLAN, TOP_UP_AMOUNTS } from "@sandchest/billing/plans";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { money, usd } from "@/lib/format";
import { addCredits, quoteCredits, type CreditsQuote } from "@/server/billing-actions";
import "./add-credits.css";

/** The amounts offered, the larger ones costing less than they add. */
const AMOUNTS = TOP_UP_AMOUNTS;

export interface CreditsAccount {
  id: string;
  login: string;
  /** Credits left. */
  credits: number;
  /** Whether the person can buy for it (an admin). */
  admin: boolean;
}

/**
 * Adding funds where the balance ran short, without leaving the page: the amounts, the smallest that covers
 * what's needed already chosen, the exact price today, and one key. On a paid plan the card on file is charged at
 * once; without one, Stripe Checkout joins the plan with them. `then` runs once they're added (start the scan
 * that needed them), and names it on the key.
 */
export function AddCredits({
  account,
  need,
  open,
  onClose,
  then,
}: {
  account: CreditsAccount;
  /** Credits the action needs available, when there is one waiting on them. */
  need?: number;
  open: boolean;
  onClose: () => void;
  then?: { label: string; run: () => void };
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const short = need === undefined ? 0 : Math.max(0, need - account.credits);
  const fits = AMOUNTS.find((amount) => amount >= short) ?? AMOUNTS.at(-1)!;
  const [amount, setAmount] = useState(fits);
  const [quote, setQuote] = useState<CreditsQuote & { for?: number }>({});
  const [error, setError] = useState<string>();
  const [added, setAdded] = useState<number>();
  const [buying, startBuying] = useTransition();
  // A purchase id per opening: pressing twice, or retrying after a timeout, never charges twice.
  const [purchaseId, setPurchaseId] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      setAmount(fits);
      setError(undefined);
      setAdded(undefined);
      setPurchaseId(crypto.randomUUID());
      element.showModal();
    } else if (!open && element.open) element.close();
  }, [open]);

  // The exact price today, from billing, for the pack chosen.
  useEffect(() => {
    if (!open || !account.admin) return;
    let current = true;
    quoteCredits(account.id, amount).then((next) => current && setQuote({ ...next, for: amount }));
    return () => {
      current = false;
    };
  }, [open, amount, account.id, account.admin]);

  const priced = quote.for === amount && quote.dueToday !== undefined;
  const joins = quote.joins ?? false;
  const buy = () =>
    startBuying(async () => {
      setError(undefined);
      const outcome = await addCredits(account.id, amount, purchaseId);
      if (outcome.error) return setError(outcome.error);
      setAdded(outcome.added);
      setPurchaseId(crypto.randomUUID());
      if (then) {
        then.run();
        onClose();
      }
    });

  return (
    <dialog ref={dialog} className="add-credits" onClose={onClose} onCancel={onClose} aria-labelledby="add-credits-title">
      <div className="add-credits-body">
        <button type="button" className="add-credits-close" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 14 14" shapeRendering="crispEdges" aria-hidden="true">
            <path d="M2 2h2v2H2zM4 4h2v2H4zM6 6h2v2H6zM8 8h2v2H8zM10 10h2v2h-2zM10 2h2v2h-2zM8 4h2v2H8zM4 8h2v2H4zM2 10h2v2H2z" fill="currentColor" />
          </svg>
        </button>

        {added !== undefined ? (
          <div className="add-credits-done" role="status">
            <p className="add-credits-done-n">+{money(added)}</p>
            <h2 id="add-credits-title" className="add-credits-title">
              Funds added
            </h2>
            <p className="add-credits-lede">They’re in {account.login}’s balance now, and never expire.</p>
            <button type="button" className="key key-secondary" onClick={onClose}>
              <span className="key-face">Done</span>
            </button>
          </div>
        ) : (
          <>
            <h2 id="add-credits-title" className="add-credits-title">
              {short > 0 ? "Top up to keep going" : "Add funds"}
            </h2>
            <p className="add-credits-lede">
              {short > 0 ? (
                <>
                  This needs {money(need!)} available, {account.login} has {money(account.credits)}.
                </>
              ) : (
                <>
                  Balance {money(account.credits)}.
                </>
              )}{" "}
              Funds you add never expire.
            </p>

            {!account.admin ? (
              <p className="add-credits-note">Only an admin of {account.login} can add funds. Ask one of them to top up.</p>
            ) : (
              <>
                <fieldset className="add-credits-packs">
                  <legend className="sr-only">Funds to add</legend>
                  {AMOUNTS.map((pack) => (
                    <label key={pack} className="add-credits-pack" data-on={pack === amount || undefined}>
                      <input type="radio" name="credits" value={pack} checked={pack === amount} onChange={() => setAmount(pack)} />
                      <span className="add-credits-pack-n">{money(pack)}</span>
                      {creditsSaving(pack) > 0 && <span className="add-credits-pack-price">for {usd(creditsPrice(pack), true)}</span>}
                      {creditsSaving(pack) > 0 ? (
                        <span className="add-credits-pack-tag">Save {usd(creditsSaving(pack), true)}</span>
                      ) : pack === fits && short > 0 ? (
                        <span className="add-credits-pack-tag add-credits-pack-fits">Covers it</span>
                      ) : null}
                    </label>
                  ))}
                </fieldset>

                <div className="add-credits-total">
                  <span>{joins ? `Today, with the ${PLAN.name} plan` : "Today"}</span>
                  <strong aria-live="polite">{priced ? usd(quote.dueToday!, true) : quote.error && quote.for === amount ? "-" : "…"}</strong>
                </div>
                <p className="add-credits-fine">
                  {joins
                    ? `Joins ${PLAN.name}, $${PLAN.price} a month, on Stripe. Any free balance left carries across.`
                    : "Charged now to the card on file."}
                </p>

                <button type="button" className="key key-primary key-large key-glow add-credits-go" onClick={buy} disabled={buying || !priced} aria-busy={buying || undefined} data-track="add-credits">
                  <span className="key-face">
                    {buying ? "Adding…" : joins ? `Continue to pay ${priced ? usd(quote.dueToday!, true) : ""}` : then ? `Add ${money(amount)} and ${then.label}` : `Add ${money(amount)}`}
                  </span>
                </button>
                {(error ?? (quote.for === amount ? quote.error : undefined)) && (
                  <p className="add-credits-error" role="alert">
                    {error ?? quote.error}
                  </p>
                )}
              </>
            )}
          </>
        )}
      </div>
    </dialog>
  );
}

/** A link-styled key that opens the dialog, for wherever the balance is shown. */
export function AddCreditsLink({ account, className, children }: { account: CreditsAccount; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} data-track="add-credits-open">
        {children}
      </button>
      <AddCredits account={account} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
