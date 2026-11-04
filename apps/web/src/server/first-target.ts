/**
 * The first Dig: once an org's first plan is active, its hacker starts on the
 * repository chosen while recruiting, using the org's free first Dig, and the
 * person is taken to watch it. Loaded on demand: it needs the workflow runtime.
 */
import { orgRepos, repoForUser } from "@sandchest/db";
import { db } from "./db";
import { describeError } from "./log";
import { captureException } from "./sentry";

/**
 * Where to go once joined: the first Dig's live view, or `fallback` if it can't start. A target that was
 * deep scanned already (recruiting again, say) isn't scanned again.
 */
export async function startFirstTarget(userId: string, org: { id: string; settings: { firstTarget?: string } }, fallback = "/dashboard?plan=started"): Promise<string> {
  const target = org.settings.firstTarget;
  if (!target || !(await orgRepos(db(), org.id)).some((repo) => repo.id === target)) return fallback;
  const row = await repoForUser(db(), userId, target);
  if (!row || row.repo.lastDeepScanAt) return fallback;
  try {
    const { requestDeepScan } = await import("./dig");
    const result = await requestDeepScan({ ...row.repo, org: row.org });
    if (result.ok) return `/dashboard/scans/${result.scanId}`;
    if (result.scanId) return `/dashboard/scans/${result.scanId}`;
  } catch (error) {
    console.error(`First dig for org ${org.id} failed: ${describeError(error)}`);
    await captureException(error, { source: "dig", tags: { action: "first_target" }, handled: true });
  }
  return fallback;
}
