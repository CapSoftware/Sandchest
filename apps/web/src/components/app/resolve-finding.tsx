import { DISMISS_REASON_LABEL } from "@/lib/format";
import { Submit } from "./submit";
import { When } from "./when";

/** Each way to dismiss a finding, said the way a person decides it. */
const REASONS: Array<{ id: "false_positive" | "accepted_risk" | "wont_fix"; name: string; hint: string }> = [
  { id: "false_positive", name: "Not a real issue", hint: "A false positive. Later scans learn from it." },
  { id: "accepted_risk", name: "Accepted risk", hint: "Real, and you’ve decided to live with it." },
  { id: "wont_fix", name: "Won’t fix", hint: "Real, but not worth changing here." },
];

/**
 * Deciding what happens to a finding: mark it fixed, dismiss it with a
 * reason, or reopen one already resolved. `change` is the finding's action;
 * `decided` is who resolved it and when, if someone did.
 */
export function ResolveFinding({
  status,
  dismissReason,
  decided,
  change,
}: {
  status: string;
  dismissReason: string | null;
  decided: { login: string | null; at: Date } | undefined;
  change: (form: FormData) => Promise<void>;
}) {
  if (status !== "open") {
    const fixed = status === "fixed";
    return (
      <section className="resolve" data-resolved={status} aria-labelledby="resolve-title">
        <h2 id="resolve-title" className="resolve-title">
          {fixed ? "Fixed" : "Dismissed"}
        </h2>
        <p className="resolve-state">
          <span className="status" data-status={status}>
            {fixed ? "Fixed" : `Dismissed: ${(DISMISS_REASON_LABEL[dismissReason ?? ""] ?? "no reason").toLowerCase()}`}
          </span>
          {decided && (
            <span className="resolve-who">
              {decided.login ? `${decided.login} · ` : fixed ? "a push · " : ""}
              <When date={decided.at} />
            </span>
          )}
        </p>
        <p className="resolve-hint">
          {fixed ? "If a later scan still finds it, it reopens on its own." : "Sandchest won’t raise it again, in scans or on pull requests."}
        </p>
        <form action={change}>
          <input type="hidden" name="type" value="reopen" />
          <Submit pending="Reopening…" track="finding-reopen">
            Reopen
          </Submit>
        </form>
      </section>
    );
  }

  return (
    <section className="resolve" aria-labelledby="resolve-title">
      <h2 id="resolve-title" className="resolve-title">
        Resolve
      </h2>
      <form action={change} className="resolve-fix">
        <input type="hidden" name="type" value="fix" />
        <Submit className="key key-secondary resolve-fix-key" pending="Marking fixed…" track="finding-mark-fixed">
          <span className="resolve-tick" aria-hidden="true" />
          Mark fixed
        </Submit>
        <p className="resolve-hint">Fixed in the code. If a later scan still finds it, it reopens.</p>
      </form>
      <form action={change} className="resolve-dismiss">
        <input type="hidden" name="type" value="dismiss" />
        <p className="resolve-ask">Or dismiss it. Why isn’t it a problem?</p>
        <div className="resolve-reasons">
          {REASONS.map((reason) => (
            <Submit key={reason.id} name="reason" value={reason.id} className="resolve-reason" bare pending={<span className="resolve-reason-name">Dismissing…</span>} track={`finding-dismiss-${reason.id}`}>
              <span className="resolve-reason-name">{reason.name}</span>
              <span className="resolve-reason-hint">{reason.hint}</span>
            </Submit>
          ))}
        </div>
        <p className="resolve-hint">It’s never raised again, and its code excerpts are deleted. You can still reopen it.</p>
      </form>
    </section>
  );
}
