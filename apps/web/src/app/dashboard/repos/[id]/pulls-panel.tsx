import type { PrReviewMode } from "@sandchest/db";
import { PullRows } from "@/components/app/pull-rows";
import { samplePulls } from "@/lib/samples";
import { repoPulls } from "@/server/pulls";

/** The repo's open pull requests, read from GitHub while the rest of the page is already showing. */
export async function PullsPanel({ userId, repoId, fullName, mode, priced }: { userId: string; repoId: string; fullName: string; mode: PrReviewMode; priced: boolean }) {
  const result = await repoPulls(userId, repoId);
  if (!result.ok) return <p className="panel-empty">GitHub didn’t answer just now, so pull requests can’t be shown. Refresh to try again.</p>;
  if (result.pulls.length === 0)
    return (
      <p className="panel-empty">
        No open pull requests.{" "}
        {mode === "auto" ? "Each one is reviewed as it’s opened and pushed to." : mode === "command" ? "Open one, then press Review here or comment /sandchest review on it." : ""}
      </p>
    );
  return (
    <>
      <PullRows repoId={repoId} pulls={result.pulls} mode={mode} priced={priced} />
      {result.pulls.length >= 20 && (
        <a className="panel-foot-link" href={`https://github.com/${fullName}/pulls`} target="_blank" rel="noreferrer">
          All open pull requests on GitHub
        </a>
      )}
    </>
  );
}

/** What shows while GitHub answers: sample rows, drawn as bars. */
export function PullsLoading({ repoId, mode, priced }: { repoId: string; mode: PrReviewMode; priced: boolean }) {
  return (
    <div className="pulls-loading" aria-busy="true" aria-label="Loading pull requests">
      <PullRows repoId={repoId} pulls={samplePulls(3)} mode={mode} priced={priced} />
    </div>
  );
}
