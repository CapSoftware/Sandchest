import type { PrReviewMode } from "@sandchest/db";
import { plural } from "@/lib/format";
import type { PullRow } from "@/server/pulls";
import { HoverLink } from "./hover-link";
import { PrReviewButton } from "./pr-review-button";
import { When } from "./when";

const ACTIVE = new Set(["queued", "running", "publishing"]);

/** What the panel says about how this repo's PRs get reviewed. */
export const MODE_NOTE: Record<PrReviewMode, string> = {
  auto: "Reviewed on every push",
  command: "Reviewed when asked",
  off: "Reviews off",
};

/**
 * A repo's open pull requests, each with Sandchest's latest review of it and,
 * where its latest commit hasn't been reviewed, a key to review it now.
 * `priced`: billing is on, so a review's price is shown and confirmed first.
 */
export function PullRows({ repoId, pulls, mode, priced }: { repoId: string; pulls: PullRow[]; mode: PrReviewMode; priced: boolean }) {
  return (
    <ul className="rows pull-rows">
      {pulls.map((pull) => (
        <li key={pull.number} className="row pull-row">
          <span className="scan-dot" data-status={pull.review?.current ? pull.review.status : "none"} aria-hidden="true" />
          <span className="pull-what">
            <a className="pull-title" href={pull.url} target="_blank" rel="noreferrer">
              <span className="pull-number">#{pull.number}</span> {pull.title}
            </a>
            <span className="pull-meta">
              {pull.draft && <span className="pull-draft">Draft · </span>}
              {pull.author && `${pull.author} · `}updated <When date={pull.updatedAt} />
            </span>
          </span>
          <span className="pull-result">
            <Result pull={pull} />
          </span>
          <span className="pull-action">{mode !== "off" && needsReview(pull) && <PrReviewButton repoId={repoId} prNumber={pull.number} again={!!pull.review} priced={priced} />}</span>
        </li>
      ))}
    </ul>
  );
}

/** Its latest commit has no review that is under way or finished. */
function needsReview(pull: PullRow): boolean {
  const review = pull.review;
  return !review || !review.current || review.status === "failed" || review.status === "refused" || review.status === "cancelled";
}

function Result({ pull }: { pull: PullRow }) {
  const review = pull.review;
  if (!review) return <span className="scan-result-quiet">Not reviewed</span>;
  const href = `/dashboard/scans/${review.scanId}`;
  if (!review.current) {
    return (
      <HoverLink href={href} className="pull-result-link scan-result-quiet">
        Reviewed an earlier commit
      </HoverLink>
    );
  }
  if (ACTIVE.has(review.status)) {
    return (
      <HoverLink href={href} className="pull-result-link scan-result-live">
        <span className="blink" aria-hidden="true" />
        {review.status === "queued" ? "Waiting to review" : "Reviewing"}
      </HoverLink>
    );
  }
  if (review.status === "failed") {
    return (
      <HoverLink href={href} className="pull-result-link scan-result-off" data-status="failed">
        Couldn’t finish
      </HoverLink>
    );
  }
  if (review.status !== "completed") {
    return (
      <HoverLink href={href} className="pull-result-link scan-result-off" data-status={review.status}>
        Not reviewed
      </HoverLink>
    );
  }
  return (
    <HoverLink href={href} className="pull-result-link" data-found={review.findings > 0 || undefined}>
      {review.findings > 0 ? plural(review.findings, "finding") : "Nothing found"}
    </HoverLink>
  );
}
