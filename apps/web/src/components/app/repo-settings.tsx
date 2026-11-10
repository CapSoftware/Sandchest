"use client";
import type { DeepScanSchedule, PrReviewMode } from "@sandchest/db";
import { useActionState, useEffect, useRef, useState } from "react";
import { fullDate, timeUntil } from "@/lib/format";
import { PR_REVIEW_PRICE } from "@/lib/pricing";
import { saveRepoSettings, type RepoSettingsOutcome } from "@/server/actions";

const MODES: Array<{ id: PrReviewMode; label: string; help: string }> = [
  { id: "auto", label: "Every push", help: `Each push to an open pull request is reviewed. A review is ${PR_REVIEW_PRICE}.` },
  {
    id: "command",
    label: "When asked",
    help: "Only when someone with write access comments /sandchest review on the pull request, or presses Review above. Nothing runs on its own.",
  },
  { id: "off", label: "Off", help: "Pull requests aren’t reviewed, and /sandchest review is ignored." },
];

const SCHEDULES: Array<{ id: DeepScanSchedule; label: string }> = [
  { id: "off", label: "Off" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
];

/**
 * A repo's review settings. Each choice saves as it's made; anyone who can
 * push to the repo may change them. `price` is what one deep scan costs it.
 */
export function RepoSettingsForm({
  repoId,
  branch,
  prReviews,
  schedule,
  nextDeepScanAt,
  price,
}: {
  repoId: string;
  branch: string;
  prReviews: PrReviewMode;
  schedule: DeepScanSchedule;
  nextDeepScanAt: Date | null;
  price: string | null;
}) {
  const [state, action, pending] = useActionState<RepoSettingsOutcome, FormData>(saveRepoSettings.bind(null, repoId), {});
  const [mode, setMode] = useState(prReviews);
  const [every, setEvery] = useState(schedule);
  const form = useRef<HTMLFormElement>(null);
  // "Saved" stays a moment after each save, then gets out of the way.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!state.saved) return;
    setShown(true);
    const timer = setTimeout(() => setShown(false), 2_000);
    return () => clearTimeout(timer);
  }, [state]);

  // The next run as last saved; until a change is saved, the page's.
  const next = state.saved ? (state.nextDeepScanAt ? new Date(state.nextDeepScanAt) : null) : every === schedule ? nextDeepScanAt : null;
  const save = () => form.current?.requestSubmit();

  return (
    <form ref={form} action={action} className="settings-form repo-settings">
      <fieldset>
        <legend className="field-legend">Pull request reviews</legend>
        <div className="segments">
          {MODES.map((option) => (
            <label key={option.id} className="segment">
              <input type="radio" name="prReviews" value={option.id} defaultChecked={prReviews === option.id} onChange={() => (setMode(option.id), save())} />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        <p className="field-help repo-settings-help">{MODES.find((option) => option.id === mode)!.help}</p>
      </fieldset>
      <fieldset>
        <legend className="field-legend">Scheduled deep scans</legend>
        <div className="segments">
          {SCHEDULES.map((option) => (
            <label key={option.id} className="segment">
              <input type="radio" name="deepScanSchedule" value={option.id} defaultChecked={schedule === option.id} onChange={() => (setEvery(option.id), save())} />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
        <p className="field-help repo-settings-help">
          {every === "off" ? (
            "Deep scans run only when you start one."
          ) : (
            <>
              A deep scan of {branch}, the same as Scan again{price ? `, for ${price} each` : ""}. Skipped when nothing has changed since the last one.
              {next && !pending && (
                <span className="repo-settings-next">
                  {" "}
                  Next:{" "}
                  <time dateTime={next.toISOString()} title={fullDate(next)}>
                    {next.getTime() - Date.now() < 10 * 60_000 ? "within 10 minutes" : timeUntil(next)}
                  </time>
                  .
                </span>
              )}
            </>
          )}
        </p>
      </fieldset>
      <p className="repo-settings-status" role="status" aria-live="polite">
        {pending ? "Saving…" : state.error ? <span data-error="">{state.error}</span> : shown ? "Saved" : ""}
      </p>
    </form>
  );
}
