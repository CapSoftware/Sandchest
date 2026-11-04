/**
 * A repo's open pull requests for its page: GitHub's list, with Sandchest's
 * latest review of each. The list is kept for a few seconds per repo, so
 * moving around the dashboard doesn't ask GitHub every time; review states
 * are always read fresh.
 */
import { prReviewStates, repoForUser, type PrReviewState } from "@sandchest/db";
import type { PullSummary } from "@sandchest/github";
import { db, githubApp } from "./services";

export interface PullRow {
  number: number;
  title: string;
  author: string | null;
  url: string;
  draft: boolean;
  updatedAt: Date;
  headSha: string;
  /** From a fork: on a public repo, only someone with push access can start its review. */
  fork: boolean;
  /** Sandchest's latest review of it, and whether that was of its latest commit. */
  review: (PrReviewState & { current: boolean }) | null;
}

/** Open PRs shown on a repo's page. */
export const PULLS_SHOWN = 20;
const TTL_MS = 15_000;
const cache = new Map<string, { at: number; pulls: Promise<PullSummary[]> }>();

export type PullsResult = { ok: true; pulls: PullRow[] } | { ok: false };

export async function repoPulls(userId: string, repoId: string): Promise<PullsResult> {
  const row = await repoForUser(db(), userId, repoId);
  if (!row?.org.installationId) return { ok: true, pulls: [] };
  const { repo, org } = row;
  let pulls: PullSummary[];
  try {
    pulls = await listed(repo.id, () => githubApp().installation(org.installationId!).pulls(repo.fullName, PULLS_SHOWN, AbortSignal.timeout(8_000)));
  } catch {
    return { ok: false };
  }
  const reviews = await prReviewStates(db(), repo.id, pulls.map((pull) => pull.number));
  return {
    ok: true,
    pulls: pulls.map((pull) => {
      const review = reviews.get(pull.number);
      return {
        number: pull.number,
        title: pull.title,
        author: pull.user?.login ?? null,
        url: pull.html_url,
        draft: pull.draft,
        updatedAt: new Date(pull.updated_at),
        headSha: pull.head.sha,
        fork: pull.head.repo?.id !== repo.githubRepoId,
        review: review ? { ...review, current: review.headSha === pull.head.sha } : null,
      };
    }),
  };
}

function listed(repoId: string, load: () => Promise<PullSummary[]>): Promise<PullSummary[]> {
  const now = Date.now();
  for (const [key, entry] of cache) if (now - entry.at > TTL_MS) cache.delete(key);
  const hit = cache.get(repoId);
  if (hit) return hit.pulls;
  const pulls = load();
  cache.set(repoId, { at: now, pulls });
  // A failure isn't kept: the next look asks again.
  pulls.catch(() => cache.delete(repoId));
  return pulls;
}
